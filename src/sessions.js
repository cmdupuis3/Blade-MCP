"use strict";

// blade_eval / blade_reset_session — stateful REPL sessions over `ide serve`.
//
// WHAT AN EVAL REPORTS. A submission follows the notebook display rule
// (src/ReplSession.fs `EvalOnce`): it shows only its "return value" — the
// final statement, and only when that statement is a bare expression.
// Declarations and reassignments run silently. So the response's `bindings`
// array holds AT MOST ONE entry: the final expression under `name: ""` (or
// under the function's own name when the expression is a bare identifier
// naming a session function, whose signature is echoed with an empty value).
// Array values are elided to the first five entries per bracket level.
//
// A failed submission (`kept: false`) leaves the session unchanged. Front-end
// rejections arrive as spanned diagnostics; a runtime guard panic
// (`error[BL8006]: ...` on stderr, both lanes) is parsed compiler-side into a
// coded diagnostic too. Diagnostics here go through the same trimming
// blade_check uses, so both tools report one shape.
//
// DISPLAY FRAMES arrive on two channels: inline in the eval response's
// `display` array, and out-of-band as `{"event":"display"}` lines while the
// eval runs (frames with a caller-chosen stable id — `plot.stream`, a
// `plotid` — are always sent that way). The package routes the latter to its
// display hub, which the context drains. Serve is strictly serial, so whatever
// is queued when an eval returns belongs to that eval.
//
// SESSION REPLAY. A session re-runs every accumulated snippet on each
// submission, so every later response carries the frames of EVERY plotting
// cell committed so far (Blade-REPL docs/display-frames.md section 10). An
// editor merges those into the plots it already shows, by `meta.id`. An agent
// has no panel to merge into: delivering them again would re-render and
// re-send the same pictures on every call for the rest of the session. So this
// module remembers, per session, what the previous run put out and delivers
// only frames that are NEW or whose bytes CHANGED — the same rule the
// compiler's own `render` lane applies ("only frames whose bytes moved are
// sent; `unchanged` counts the rest").
//
// RESTARTS. Every session lives inside the one `ide serve` process. When that
// process is replaced — a request (of ANY tool) outlived its timeout and the
// client killed it, or it crashed — every session silently starts over empty.
// The call that failed says so, but the session's owner may be a different
// call, much later. So each session remembers which process generation its
// last eval ran under, and the first eval after a change says the definitions
// are gone rather than leaving the agent to puzzle over "Unbound variable".
//
// PLOT UPGRADE. A raster frame is already an MCP image block, but a plotly
// frame is a figure SPEC — JSON an agent cannot see. Left alone it degrades to
// a truncated `[display application/vnd.plotly.v1+json]` dump, which costs
// context and conveys nothing. So when a GR runtime is available (src/gr.js)
// the compiler's `renderPlot` verb re-renders each such spec to a PNG and that
// image goes to the agent instead. This is post-hoc: nothing re-runs, the
// figure spec the program already emitted is all it needs.
//
// Every failure on that path falls back to the old text rendering. An eval
// that produced correct output must never be reported as failed because a
// picture of it could not be drawn.

const crypto = require("crypto");

const compiler = require("./compiler");
const checks = require("./checks");

const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
const MAX_TEXT_FRAME_CHARS = 8192;

/** Fallback for a package too old to export it (the mime is wire-stable). */
const PLOTLY_MIME = "application/vnd.plotly.v1+json";

// Default render size. The GR measurements behind this work put an 800px PNG
// of a typical line plot at ~13 KB and a 1200px one at ~21 KB, so both are far
// under the 1 MB inline cap and the choice is about legibility per token, not
// bytes. 800x600 is the compiler's own default, is readable when an agent's
// client downsamples, and keeps a multi-plot eval cheap; `plotWidth`/
// `plotHeight` on blade_eval raise it when detail actually matters.
const DEFAULT_PLOT_WIDTH = 800;
const DEFAULT_PLOT_HEIGHT = 600;
// The compiler clamps to this range too; clamping here as well means a silly
// argument becomes a sensible picture rather than a protocol error.
const MIN_PLOT_PX = 64;
const MAX_PLOT_PX = 4096;

// One eval can emit many figures. Each render is a round trip through a native
// GR worker, so a runaway loop that plots 200 times would otherwise stall the
// tool call for minutes and bury the agent in images. Past this many, the rest
// degrade to text with a note.
const MAX_PLOT_RENDERS = 8;

// ...and a streaming program (`plot.stream` in a training loop) emits one
// frame per instalment, each of which would otherwise become a text block of
// up to MAX_TEXT_FRAME_CHARS. Past this many NEW frames in one eval the rest
// are counted, not delivered.
const MAX_DISPLAY_FRAMES = 24;

/** Per-call render timeout. GR's FIRST render in a serve process pays a ~2.6s
 *  cold start; later ones are tens of ms. */
const PLOT_RENDER_TIMEOUT_MS = 30000;

function truncate(text, limit) {
  const s = String(text);
  return s.length <= limit ? s : `${s.slice(0, limit)}\n… [truncated, ${s.length} chars total]`;
}

function base64Bytes(data) {
  const clean = String(data).replace(/\s+/g, "");
  return Math.floor((clean.length * 3) / 4);
}

/** One display frame -> one MCP content block. Never throws; degrades to text. */
function frameContent(frame) {
  try {
    const mime = frame.mime;
    if (/^image\//.test(mime) && frame.encoding === "base64") {
      const data = String(frame.data).replace(/\s+/g, "");
      const bytes = base64Bytes(data);
      if (bytes > MAX_INLINE_IMAGE_BYTES) {
        return { type: "text", text: `[display frame omitted: ${mime}, ~${bytes} bytes exceeds the 1 MB inline limit]` };
      }
      return { type: "image", data, mimeType: mime };
    }
    if (/^text\//.test(mime)) {
      const text = frame.encoding === "base64" ? Buffer.from(String(frame.data), "base64").toString("utf8") : String(frame.data);
      return { type: "text", text: truncate(text, MAX_TEXT_FRAME_CHARS) };
    }
    if (frame.encoding === "json") {
      return { type: "text", text: truncate(`[display ${mime}]\n${JSON.stringify(frame.data, null, 2)}`, MAX_TEXT_FRAME_CHARS) };
    }
    return { type: "text", text: `[display frame: ${mime}, ${frame.encoding}, ${String(frame.data).length} chars]` };
  } catch (e) {
    return { type: "text", text: `[display frame could not be rendered: ${e.message}]` };
  }
}

/** The plotly mime, from the package when it exports it. */
function plotlyMime(ctx) {
  const d = ctx && ctx.pkg && ctx.pkg.display;
  return (d && d.PLOTLY_MIME) || PLOTLY_MIME;
}

function isPlotFrame(frame, mime) {
  return !!frame && frame.mime === mime && frame.data !== null && typeof frame.data === "object";
}

/** A figure's title for the companion text line. The frame format's own rule
 *  (display-frames.md section 5): `meta.title` first — it is what
 *  `display.emit` callers set — then plotly's `layout.title`, which is either
 *  a string or `{text}`. Absent is fine. */
function plotTitle(frame) {
  try {
    const m = frame.meta && frame.meta.title;
    if (typeof m === "string" && m.trim() !== "") return m.trim();
    const t = frame.data && frame.data.layout && frame.data.layout.title;
    const text = typeof t === "string" ? t : t && typeof t.text === "string" ? t.text : null;
    return text && text.trim() !== "" ? text.trim() : null;
  } catch (_) {
    return null;
  }
}

function clampPx(value, fallback) {
  if (typeof value !== "number" || !isFinite(value)) return fallback;
  return Math.max(MIN_PLOT_PX, Math.min(MAX_PLOT_PX, Math.round(value)));
}

/**
 * Frames -> MCP content blocks, upgrading plotly figure specs to GR-rendered
 * PNGs when that is possible.
 *
 * Returns `{content, rendered, note}`:
 *   - non-plot frames go through frameContent untouched (a program that emits
 *     its own image/png is unaffected by any of this),
 *   - a rendered figure contributes TWO blocks: a one-line `[plot: <title>]`
 *     text label, then the image. The label costs a handful of tokens and is
 *     what lets an agent refer to "the residuals plot" rather than "the second
 *     picture"; MCP image blocks carry no caption of their own.
 *   - anything that cannot be rendered falls back to frameContent's existing
 *     JSON text, and `note` says why — ONCE for the whole eval, not per frame.
 *
 * The first render failure disables rendering for the rest of THIS eval: the
 * causes (no GR worker, a compiler predating the verb, a broken GR tree) are
 * all per-process, so retrying per frame only multiplies the timeout.
 */
async function framesToContent(frames, ctx, args) {
  const mime = plotlyMime(ctx);
  const plots = frames.filter((f) => isPlotFrame(f, mime));
  if (plots.length === 0) return { content: frames.map(frameContent), rendered: 0 };

  const width = clampPx(args && args.plotWidth, DEFAULT_PLOT_WIDTH);
  const height = clampPx(args && args.plotHeight, DEFAULT_PLOT_HEIGHT);

  const gr = typeof ctx.grRuntime === "function" ? ctx.grRuntime() : { ok: false, reason: "this server was built without GR support" };
  let note;
  let renderer = gr.ok;
  if (!gr.ok) {
    note = `${plots.length} plotly figure(s) were left as JSON text because GR is unavailable: ${gr.reason}`;
  }

  const content = [];
  let rendered = 0;
  for (const frame of frames) {
    if (!isPlotFrame(frame, mime)) {
      content.push(frameContent(frame));
      continue;
    }
    if (renderer && rendered >= MAX_PLOT_RENDERS) {
      renderer = false;
      note = `only the first ${MAX_PLOT_RENDERS} figures of this eval were rendered as images; the rest are JSON text`;
    }
    if (!renderer) {
      content.push(frameContent(frame));
      continue;
    }
    try {
      const resp = await ctx.getClient().renderPlot(
        {
          spec: frame.data,
          plotId: frame.meta && typeof frame.meta.id === "string" ? frame.meta.id : undefined,
          width,
          height,
        },
        { timeoutMs: PLOT_RENDER_TIMEOUT_MS }
      );
      if (!resp || !resp.frame || !resp.frame.mime) throw new Error("renderPlot returned no frame");
      const title = plotTitle(frame);
      // frameContent enforces the 1 MB inline cap on the render exactly as it
      // does on a program's own image frame — a huge PNG becomes the same size
      // placeholder rather than a wall of base64.
      content.push({ type: "text", text: `[plot: ${title || "untitled"} — GR render, ${width}x${height}]` });
      content.push(frameContent(resp.frame));
      rendered++;
    } catch (e) {
      renderer = false;
      const why = e && e.protocolError ? `${e.message} (the compiler answered but could not render — it may predate 'renderPlot', or its GR worker failed to start)` : e && e.message ? e.message : String(e);
      note = `plotly figures were left as JSON text because the GR render failed: ${why}`;
      content.push(frameContent(frame));
    }
  }
  return { content, rendered, note };
}

/**
 * A frame's identity AND content as one digest: the plot's `meta.id` plus
 * every byte of its payload.
 *
 * The whole payload, deliberately. An earlier key sampled the payload's length
 * and first 64 characters, and two figures over the same x axis whose y values
 * print to the same width agree on both — the second plot was silently dropped.
 * `meta.id` is in the digest because the same bytes under two ids are two
 * plots, and it is what makes a re-emission in the g++ fallback lane (which
 * repeats frames already streamed, section 3 of the frame spec) collapse.
 */
function frameKey(frame) {
  const id = frame && frame.meta && typeof frame.meta.id === "string" ? frame.meta.id : "";
  const data = frame && typeof frame.data === "string" ? frame.data : JSON.stringify(frame && frame.data);
  return crypto
    .createHash("sha1")
    .update(`${frame && frame.mime}\n${frame && frame.encoding}\n${id}\n`)
    .update(String(data))
    .digest("hex");
}

function collectFrames(resp, ctx) {
  const errors = [];
  let frames = [];
  try {
    const fromResp = ctx.pkg.display.framesFromEval(resp);
    frames = frames.concat(fromResp.frames || []);
    for (const r of fromResp.errors || []) errors.push(r);
  } catch (e) {
    errors.push(`could not read the response's display frames: ${e.message}`);
  }
  try {
    frames = frames.concat(ctx.drainFrames());
  } catch (e) {
    errors.push(`could not drain streamed display frames: ${e.message}`);
  }
  const seen = new Set();
  const unique = [];
  for (const f of frames) {
    let key;
    try {
      key = frameKey(f);
    } catch (_) {
      // An undigestable frame is kept: frameContent degrades it to text.
      unique.push(f);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return { frames: unique, errors };
}

// --- session replay ------------------------------------------------------------

/** ctx -> (session key -> (frameKey digest -> the variants it was delivered
 *  in)), describing the session's last complete run. Keyed weakly by context,
 *  so a unit test's hand-rolled ctx works without createContext knowing about
 *  any of this. */
const shownByContext = new WeakMap();

function shownFor(ctx) {
  let bySession = shownByContext.get(ctx);
  if (!bySession) {
    bySession = new Map();
    shownByContext.set(ctx, bySession);
  }
  return bySession;
}

/**
 * Split one eval's frames into the ones to deliver and a count of replays.
 *
 * A frame is a REPLAY when the session's previous run produced the very same
 * bytes under the very same id. `complete` says whether this run got to the
 * end (the submission was accepted): a complete run's frames REPLACE the
 * memory, so a plot that goes A -> B -> A is delivered all three times, while
 * a rejected or panicked submission — which re-emits only part of the session,
 * or nothing — is merged in, so the next good run does not re-deliver
 * everything it skipped.
 *
 * `variantOf(frame)` (optional) names HOW the frame is about to be presented;
 * a frame already delivered, but never in this variant, is delivered again.
 * blade_eval passes the render size for plot frames, so re-running a cell
 * with a larger `plotWidth` to read fine detail gets its picture rather than
 * "unchanged". Variants accumulate for as long as the frame itself survives,
 * so going back to a size already seen does not re-send it.
 *
 * At most `limit` frames are delivered. The overflow is counted in `omitted`
 * and NOT remembered as shown — so when it comes from committed cells, the
 * next eval of the session delivers the next batch instead of calling frames
 * nobody saw "unchanged".
 */
function splitReplayed(frames, ctx, session, complete, variantOf, limit) {
  const bySession = shownFor(ctx);
  const previous = bySession.get(session) || new Map();
  const current = new Map();
  const cap = typeof limit === "number" ? limit : Infinity;
  const fresh = [];
  let unchanged = 0;
  let omitted = 0;
  for (const f of frames) {
    let key;
    let variant;
    try {
      key = frameKey(f);
      variant = (typeof variantOf === "function" && variantOf(f)) || "";
    } catch (_) {
      if (fresh.length < cap) fresh.push(f);
      else omitted++;
      continue;
    }
    const delivered = previous.get(key);
    if (!current.has(key)) current.set(key, new Set(delivered || []));
    if (delivered && delivered.has(variant)) {
      unchanged++;
    } else if (fresh.length < cap) {
      fresh.push(f);
      current.get(key).add(variant);
    } else {
      omitted++;
      if (current.get(key).size === 0) current.delete(key);
    }
  }
  if (complete) bySession.set(session, current);
  else {
    for (const [key, variants] of current) previous.set(key, variants);
    bySession.set(session, previous);
  }
  return { fresh, unchanged, omitted };
}

function forgetSession(ctx, session) {
  shownFor(ctx).delete(session);
}

/** The serve process — and with it every session — is gone. */
function forgetAllSessions(ctx) {
  shownByContext.delete(ctx);
}

// --- restarts ------------------------------------------------------------------

/** ctx -> (session key -> the serve generation its last accepted eval ran under). */
const generationByContext = new WeakMap();

function generationsFor(ctx) {
  let bySession = generationByContext.get(ctx);
  if (!bySession) {
    bySession = new Map();
    generationByContext.set(ctx, bySession);
  }
  return bySession;
}

function currentGeneration(ctx) {
  try {
    return typeof ctx.serveGeneration === "function" ? ctx.serveGeneration() : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Did the serve process get replaced between this session's previous eval and
 * the one that just ran? Records the current generation for next time. A
 * session with no earlier eval has nothing to lose, so it never reports one.
 */
function noteGeneration(ctx, session) {
  const now = currentGeneration(ctx);
  if (now === undefined) return false;
  const bySession = generationsFor(ctx);
  const before = bySession.get(session);
  bySession.set(session, now);
  return before !== undefined && before !== now;
}

// --- blade_eval ----------------------------------------------------------------

function diagRegistry(ctx) {
  try {
    return typeof ctx.diagRegistry === "function" ? ctx.diagRegistry() : new Map();
  } catch (_) {
    return new Map();
  }
}

/** Advice for a failure the diagnostics do not already explain. */
function failureHint(resp, diagnostics) {
  if (resp.exitCode === 0 || resp.lane !== "gpp") return undefined;
  if (diagnostics.some((d) => d.code)) return undefined; // a coded panic explains itself
  const text = `${resp.stderr || ""}`;
  if (/requires g\+\+|g\+\+[^\n]*not found/i.test(text)) {
    return (
      "this input needed the compiled (g++) fallback lane and no g++ was found — put a g++ toolchain on the PATH " +
      "this server was started with (on Windows: MSYS2 ucrt64, C:\\msys64\\ucrt64\\bin), then check blade_doctor's `gpp` row"
    );
  }
  return "this input needed the compiled (g++) fallback lane and that lane failed — stderr has the toolchain's message; blade_doctor's `gpp` row says whether g++ compiles and runs at all";
}

async function bladeEval(args, ctx) {
  if (typeof args.source !== "string" || args.source === "") {
    throw new compiler.UserError("`source` is required and must be non-empty Blade text");
  }
  // The same normalization blade_check applies: no BOM, no lone surrogate.
  const source = checks.normalizeSource(args.source, "`source`");
  const cwd = checks.validateCwd(args.cwd, ctx);
  const session = typeof args.session === "string" && args.session !== "" ? args.session : "default";
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 120000;

  // Drop anything left over from an earlier call so frames can't be misattributed.
  ctx.drainFrames();

  let resp;
  try {
    resp = await compiler.callServe(() => ctx.getClient().eval(session, source, cwd, timeoutMs));
  } catch (e) {
    if (e && e.protocolError) {
      return compiler.toolError(
        `blade_eval: this compiler does not support 'eval' (${e.message}) — it predates REPL/notebook support. Rebuild from a newer Blade checkout, or use blade_check.`,
        { resolvedCompiler: ctx.resolved(), protocolError: true }
      );
    }
    // A transport failure means the serve process is being replaced, and the
    // sessions died with it: what they had shown is no longer a baseline.
    forgetAllSessions(ctx);
    try {
      ctx.drainFrames();
    } catch (_) {
      /* nothing to drop */
    }
    return compiler.serveErrorResult(ctx, e, "blade_eval");
  }

  // A restart since this session's last eval: it began this call empty, and
  // what it had shown is no baseline for the frames below.
  const restarted = noteGeneration(ctx, session);
  if (restarted) forgetSession(ctx, session);

  const collected = collectFrames(resp, ctx);
  const errors = collected.errors;
  const plotMime = plotlyMime(ctx);
  const renderSize = `@${clampPx(args.plotWidth, DEFAULT_PLOT_WIDTH)}x${clampPx(args.plotHeight, DEFAULT_PLOT_HEIGHT)}`;
  const { fresh: frames, unchanged, omitted } = splitReplayed(
    collected.frames,
    ctx,
    session,
    resp.kept === true,
    (f) => (isPlotFrame(f, plotMime) ? renderSize : ""),
    MAX_DISPLAY_FRAMES
  );

  // Never let the picture path fail the eval: framesToContent already handles
  // its own errors, and this belt-and-braces catch covers a context whose
  // client is shaped differently than expected.
  let media = { content: [], rendered: 0 };
  try {
    media = await framesToContent(frames, ctx, args);
  } catch (e) {
    media = { content: frames.map(frameContent), rendered: 0, note: `display frames could not be converted: ${e.message}` };
  }

  const registry = diagRegistry(ctx);
  const diagnostics = (Array.isArray(resp.diagnostics) ? resp.diagnostics : []).map((d) => checks.trimDiagnostic(d, registry));

  const structured = {
    ok: resp.exitCode === 0,
    session,
    kept: resp.kept,
    exitCode: resp.exitCode,
    lane: resp.lane,
    elapsedMs: resp.elapsedMs,
    stdout: resp.stdout,
    stderr: resp.stderr,
    bindings: Array.isArray(resp.bindings) ? resp.bindings : [],
    diagnostics,
    // Frames this eval delivered: new ones, and ones whose content changed.
    displayFrames: frames.length,
  };
  if (restarted) {
    structured.sessionRestarted = true;
    structured.sessionNote =
      "the compiler process was restarted since this session's previous eval (a request timed out, or the process crashed), " +
      "so everything this session had defined before this call is gone — this submission ran in an empty session. Re-evaluate the definitions you still need.";
  }
  const hint = failureHint(resp, diagnostics);
  if (hint) structured.hint = hint;
  if (errors.length) structured.displayErrors = errors;

  const displayNotes = [];
  if (unchanged) {
    structured.displayFramesUnchanged = unchanged;
    displayNotes.push(
      `${unchanged} display frame(s) were re-emitted unchanged by cells evaluated earlier in this session and were not sent again` +
        " (a session re-runs its accumulated cells on every eval; blade_reset_session starts it over)"
    );
  }
  if (omitted) {
    structured.displayFramesOmitted = omitted;
    displayNotes.push(
      `this eval produced ${frames.length + omitted} new display frames; only the first ${MAX_DISPLAY_FRAMES} are included — plot once at the end rather than per iteration`
    );
  }
  if (displayNotes.length) structured.displayNote = displayNotes.join("; ");

  if (media.rendered) structured.plotsRendered = media.rendered;
  // Reported as data, not as an error: the eval itself succeeded. It rides the
  // structured payload (which is also content[0]'s text), so the agent sees the
  // reason exactly once however it reads the result.
  if (media.note) structured.plotRenderNote = media.note;

  return compiler.toolResult(structured, media.content);
}

async function bladeResetSession(args, ctx) {
  const session = typeof args.session === "string" && args.session !== "" ? args.session : "default";
  try {
    await compiler.callServe(() => ctx.getClient().resetSession(session));
  } catch (e) {
    if (e && e.protocolError) {
      return compiler.toolError(
        `blade_reset_session: this compiler predates resetSession (${e.message}) — rebuild from a newer Blade checkout, or switch to a fresh session name.`,
        { resolvedCompiler: ctx.resolved(), session, protocolError: true }
      );
    }
    forgetAllSessions(ctx);
    return compiler.serveErrorResult(ctx, e, "blade_reset_session");
  }
  // The session starts over: its plots are new again, and it has nothing a
  // later restart could lose.
  forgetSession(ctx, session);
  generationsFor(ctx).delete(session);
  return compiler.toolResult({ ok: true, session });
}

module.exports = {
  bladeEval,
  bladeResetSession,
  frameContent,
  frameKey,
  collectFrames,
  splitReplayed,
  framesToContent,
  plotTitle,
  failureHint,
  DEFAULT_PLOT_WIDTH,
  DEFAULT_PLOT_HEIGHT,
  MAX_PLOT_RENDERS,
  MAX_DISPLAY_FRAMES,
};
