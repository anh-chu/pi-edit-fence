/**
 * pi-edit-fence
 *
 * Stops concurrent pi sessions in the same directory from clobbering each other's
 * edits, without git worktrees. Each session auto-claims a lock as it edits.
 *
 * Default scope is per-file: a session that edits a file locks that exact file;
 * sibling files are never fenced. Switch SCOPE to "dir" for subtree coordination.
 *
 * Behaviour:
 *   - Editing a file/area locked by another LIVE session is blocked with a named owner.
 *   - The block is temporary: the editor waits briefly, then gets a retry-later message.
 *   - Locks auto-expire after inactivity (lease), and faster when another session is waiting.
 *   - Crashed sessions are detected by dead pid and their locks are reclaimed.
 *   - Shared paths (configs, lockfiles, root files) warn instead of block.
 *
 * Registry: <cwd>/.pi/ownership.json  (runtime data, auto-gitignored)
 *
 * Tool (agent-callable):
 *   release_path        release your lock(s) when done, for instant handover
 *
 * Commands (human, in the pi prompt):
 *   /claims             list live locks
 *   /claim <key>        manually claim a file/subtree
 *   /release [key]      drop one or all of your locks
 *   /steal <key>        force-reassign a lock to this session
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---- tunables ----
// Lock granularity.
//   "file" (default): lock the exact file. Matches the real threat (two sessions writing the
//                      same file = lost work). Sibling files in the same dir are never fenced.
//   "dir":            lock a subtree for coordination. CLAIM_DEPTH sets how many path segments
//                      under cwd form the key (2 => src/api and src/ui are distinct areas).
const SCOPE: "file" | "dir" = "file";
const CLAIM_DEPTH = 2; // only used when SCOPE === "dir"
const SHARED_PATTERNS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"tsconfig*.json",
	"*.config.js",
	"*.config.ts",
	"*.config.mjs",
	".env*",
	"README*",
	".pi/**",
	".gitignore",
];
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 25;
// Lease: a claim auto-expires this long after the owner last edited that subtree.
// Moving on to other work releases the subtree without any explicit action.
const LEASE_MS = 5 * 60 * 1000;
// When another session is actively waiting on a subtree, the owner's idle lease
// shortens to this. A genuinely-done owner frees fast, but only under contention;
// a solo owner keeps the full LEASE_MS.
const CONTENDED_LEASE_MS = 20 * 1000;
// On a blocked edit, wait this long for the owner to release/expire before giving
// the agent a retry-later message (transparently absorbs brief overlaps).
const WAIT_MS = 15 * 1000;
const POLL_MS = 500;

type Claim = { session: string; pid: number; dir: string; ts: number; contendedAt?: number };
type Registry = { claims: Claim[] };

export default function (pi: ExtensionAPI) {
	// Stable per-process identity. pid drives liveness; session label is cosmetic.
	const PID = process.pid;
	let sessionLabel = `pid-${PID}`;

	pi.on("session_start", (_event, ctx) => {
		const f = ctx.sessionManager.getSessionFile();
		sessionLabel = f ? path.basename(f).replace(/\.[^.]+$/, "") : `eph-${crypto.randomUUID().slice(0, 8)}`;
		ensureGitignore(ctx.cwd);
	});

	// Keep runtime files out of git without touching the repo-root .gitignore.
	// Scoped to .pi/ so project-local .pi/extensions stay committable.
	function ensureGitignore(cwd: string) {
		try {
			const dir = path.join(cwd, ".pi");
			fs.mkdirSync(dir, { recursive: true });
			const gi = path.join(dir, ".gitignore");
			const want = ["/ownership.json", "/ownership.lock", "/ownership.json.*.tmp"];
			let cur = "";
			try {
				cur = fs.readFileSync(gi, "utf8");
			} catch {
				/* no file yet */
			}
			const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
			const add = want.filter((w) => !have.has(w));
			if (add.length === 0) return;
			const out = (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + add.join("\n") + "\n";
			fs.writeFileSync(gi, out);
		} catch {
			/* best effort */
		}
	}

	// ---- registry IO (atomic, lock-guarded) ----
	const regPath = (cwd: string) => path.join(cwd, ".pi", "ownership.json");
	const lockPath = (cwd: string) => path.join(cwd, ".pi", "ownership.lock");

	function acquireLock(cwd: string): boolean {
		const lp = lockPath(cwd);
		fs.mkdirSync(path.dirname(lp), { recursive: true });
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				fs.mkdirSync(lp); // atomic: succeeds only for one writer
				return true;
			} catch {
				// stale lock guard: if older than timeout, steal it
				try {
					const age = Date.now() - fs.statSync(lp).mtimeMs;
					if (age > LOCK_TIMEOUT_MS) {
						fs.rmdirSync(lp);
						continue;
					}
				} catch {
					/* lock vanished, retry */
				}
				if (Date.now() > deadline) return false;
				// busy-wait sleep
				const until = Date.now() + LOCK_RETRY_MS;
				while (Date.now() < until) {
					/* spin */
				}
			}
		}
	}
	function releaseLock(cwd: string) {
		try {
			fs.rmdirSync(lockPath(cwd));
		} catch {
			/* already gone */
		}
	}
	function readReg(cwd: string): Registry {
		try {
			return JSON.parse(fs.readFileSync(regPath(cwd), "utf8")) as Registry;
		} catch {
			return { claims: [] };
		}
	}
	function writeReg(cwd: string, reg: Registry) {
		const p = regPath(cwd);
		const tmp = `${p}.${PID}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
		fs.renameSync(tmp, p); // atomic replace
	}
	function alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e: any) {
			return e?.code === "EPERM"; // exists but not ours
		}
	}
	function sweep(reg: Registry): Registry {
		const now = Date.now();
		// Drop claims whose owner process is gone (crash) OR whose lease lapsed (owner moved on).
		// A contended claim uses the short lease so a done-but-idle owner frees fast under pressure.
		reg.claims = reg.claims.filter((c) => {
			const lease = c.contendedAt != null ? CONTENDED_LEASE_MS : LEASE_MS;
			return alive(c.pid) && now - c.ts < lease;
		});
		return reg;
	}

	// run a read-modify-write under lock; returns the callback result or null if lock failed
	function withReg<T>(cwd: string, fn: (reg: Registry) => T): T | null {
		if (!acquireLock(cwd)) return null;
		try {
			const reg = sweep(readReg(cwd));
			const out = fn(reg);
			writeReg(cwd, reg);
			return out;
		} finally {
			releaseLock(cwd);
		}
	}

	// ---- path classification ----
	function relOf(cwd: string, input: string): string | null {
		const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input);
		const rel = path.relative(cwd, abs);
		if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside repo → not fenced
		return rel.split(path.sep).join("/");
	}
	function claimKey(rel: string): string {
		if (SCOPE === "file") return rel; // exact-file lock
		const segs = rel.split("/");
		if (segs.length <= 1) return rel; // root file → its own key (will be shared anyway)
		return segs.slice(0, CLAIM_DEPTH).join("/");
	}
	function globToRe(g: string): RegExp {
		const re = g
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, "\u0000")
			.replace(/\*/g, "[^/]*")
			.replace(/\u0000/g, ".*");
		return new RegExp(`^${re}$`);
	}
	const sharedRes = SHARED_PATTERNS.map(globToRe);
	function isShared(rel: string): boolean {
		if (!rel.includes("/")) return true; // any root-level file = shared zone
		const base = rel.split("/").pop()!;
		return sharedRes.some((r) => r.test(rel) || r.test(base));
	}

	// ---- the fence ----
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const input = (event.input.path ?? event.input.file_path) as string | undefined;
		if (!input) return undefined;

		const cwd = ctx.cwd;
		const rel = relOf(cwd, input);
		if (rel === null) return undefined; // outside repo

		const key = claimKey(rel);
		const shared = isShared(rel);

		// One attempt: claim if free / refresh own lease / report contention.
		const tryClaim = () =>
			withReg(cwd, (reg) => {
				const owner = reg.claims.find((c) => c.dir === key);
				if (owner && owner.pid !== PID) {
					if (shared) return { kind: "warn" as const, owner };
					owner.contendedAt = Date.now(); // someone's waiting → shorten owner's idle lease
					return { kind: "block" as const, owner };
				}
				if (owner) {
					owner.ts = Date.now(); // refresh own lease — still active here
					delete owner.contendedAt; // active edit clears contention pressure
				} else {
					reg.claims.push({ session: sessionLabel, pid: PID, dir: key, ts: Date.now() });
				}
				return { kind: "allow" as const };
			});

		let result = tryClaim();

		// Retry-later, handled transparently: if blocked, wait briefly for the owner to
		// release or its lease to lapse, polling. Absorbs short overlaps without aborting.
		if (result?.kind === "block") {
			const deadline = Date.now() + WAIT_MS;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, POLL_MS));
				result = tryClaim();
				if (!result || result.kind !== "block") break;
			}
		}

		if (result === null) {
			// could not lock registry — fail open, but tell the user
			if (ctx.hasUI) ctx.ui.notify(`path-fence: registry busy, allowing ${rel}`, "warning");
			return undefined;
		}
		if (result.kind === "block") {
			return {
				block: true,
				reason:
					`path-fence: ${SCOPE === "file" ? "file" : "area"} "${key}" is currently locked by another active pi session (${result.owner.session}, pid ${result.owner.pid}). ` +
					`This lock is TEMPORARY and releases automatically when that session moves on. ` +
					`Do not loop-retry now. Instead: ${SCOPE === "file" ? "work on OTHER files" : `work on files OUTSIDE "${key}"`} first, then RETRY this edit LATER — it will succeed once the other session is done. ` +
					`If you have no other work, tell the user "${key}" is held by another session (they can run "/steal ${key}" to force handover; you cannot run that yourself).`,
			};
		}
		if (result.kind === "warn" && ctx.hasUI) {
			ctx.ui.notify(
				`path-fence: ${rel} is in shared zone, also claimed by ${result.owner.session} (pid ${result.owner.pid}). Proceeding.`,
				"warning",
			);
		}
		return undefined;
	});

	// release this session's claims on exit
	pi.on("session_shutdown", (_event, ctx) => {
		withReg(ctx.cwd, (reg) => {
			reg.claims = reg.claims.filter((c) => c.pid !== PID);
		});
	});

	// ---- agent-callable release (fast handover; lease auto-expiry is the fallback) ----
	pi.registerTool({
		name: "release_path",
		label: "Release path lock",
		description:
			"Release this session's path-fence lock(s) once you are DONE editing there, " +
			"so other concurrent pi sessions can edit immediately. Pass the exact file path you locked (or, in dir-scope, the subtree). " +
			"Call with no args to release all your locks. Locks also auto-expire after inactivity; calling this is faster and good hygiene when you finish.",
		parameters: Type.Object({
			dir: Type.Optional(
				Type.String({ description: "Lock key to release: the file path (file-scope) or subtree (dir-scope). Omit to release all your locks." }),
			),
		}),
		async execute(_id: string, params: { dir?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const dir = (params.dir ?? "").trim().replace(/\/+$/, "");
			let freed: string[] = [];
			withReg(ctx.cwd, (reg) => {
				freed = reg.claims.filter((c) => c.pid === PID && (!dir || c.dir === dir)).map((c) => c.dir);
				reg.claims = reg.claims.filter((c) => !(c.pid === PID && (!dir || c.dir === dir)));
			});
			const msg = freed.length ? `Released: ${freed.join(", ")}` : dir ? `No lock held on "${dir}"` : "No locks held";
			return { content: [{ type: "text", text: msg }], details: { freed } };
		},
	});
	// ---- commands ----
	pi.registerCommand("claims", {
		description: "List live path-ownership claims",
		handler: async (_args, ctx) => {
			const reg = sweep(readReg(ctx.cwd));
			if (reg.claims.length === 0) return ctx.ui.notify("path-fence: no live claims", "info");
			const lines = reg.claims
				.map((c) => `${c.dir}  ←  ${c.session} (pid ${c.pid})${c.pid === PID ? " [you]" : ""}`)
				.join("\n");
			ctx.ui.notify(`Claims:\n${lines}`, "info");
		},
	});

	pi.registerCommand("claim", {
		description: "Manually claim a subtree (e.g. /claim src/api)",
		handler: async (args, ctx) => {
			const dir = args.trim().replace(/\/+$/, "");
			if (!dir) return ctx.ui.notify("usage: /claim <dir>", "warning");
			const r = withReg(ctx.cwd, (reg) => {
				const owner = reg.claims.find((c) => c.dir === dir);
				if (owner && owner.pid !== PID) return { taken: owner };
				if (!owner) reg.claims.push({ session: sessionLabel, pid: PID, dir, ts: Date.now() });
				return { taken: null };
			});
			if (r?.taken) ctx.ui.notify(`"${dir}" already owned by ${r.taken.session} (pid ${r.taken.pid}). Use /steal.`, "warning");
			else ctx.ui.notify(`Claimed ${dir}`, "info");
		},
	});

	pi.registerCommand("release", {
		description: "Release your claims (/release [dir], no arg = all yours)",
		handler: async (args, ctx) => {
			const dir = args.trim().replace(/\/+$/, "");
			withReg(ctx.cwd, (reg) => {
				reg.claims = reg.claims.filter((c) => !(c.pid === PID && (!dir || c.dir === dir)));
			});
			ctx.ui.notify(dir ? `Released ${dir}` : "Released all your claims", "info");
		},
	});

	pi.registerCommand("steal", {
		description: "Force-reassign a claim to this session (/steal <dir>)",
		handler: async (args, ctx) => {
			const dir = args.trim().replace(/\/+$/, "");
			if (!dir) return ctx.ui.notify("usage: /steal <dir>", "warning");
			withReg(ctx.cwd, (reg) => {
				reg.claims = reg.claims.filter((c) => c.dir !== dir);
				reg.claims.push({ session: sessionLabel, pid: PID, dir, ts: Date.now() });
			});
			ctx.ui.notify(`Stole ${dir} → ${sessionLabel}`, "warning");
		},
	});
}
