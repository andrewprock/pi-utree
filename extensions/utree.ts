/**
 * /utree - conversation view with the same UX as the built-in /tree
 *
 * Reuses pi's own TreeSelectorComponent (the exact /tree UI: arrow navigation,
 * search-as-you-type, fold/unfold, ctrl+x copy, filters) but feeds it a pruned
 * tree that shows a clean conversation:
 *
 *   user:
 *   assistant:   <- only the LAST assistant response of each turn
 *   user:
 *   assistant:
 *   ...
 *
 * Thinking blocks, tool calls, and tool results are excluded, and chains of
 * assistant messages within one turn (progress updates between tool calls)
 * are collapsed to the final response.
 *
 * Enter navigates the session to the selected point, mirroring /tree
 * (including the "Summarize branch?" prompt). ctrl+p previews the selected
 * entry full screen, so a long answer is read from its first line instead of
 * the bottom of the transcript. Inside the preview, left/right walk
 * neighbouring entries, j/k, space/b and g/G scroll, and c puts the entry in
 * the editor as quoted context for a follow-up question.
 *
 * In print/JSON mode it writes a plain transcript to stdout instead.
 */

import {
	TreeSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

const PREVIEW_KEY = Key.ctrl("p");

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

function roleOf(entry: SessionEntry): "user" | "assistant" | undefined {
	if (entry.type !== "message") return undefined;
	const message = (entry as { message?: { role?: string } }).message;
	return message?.role as "user" | "assistant" | undefined;
}

function hasText(entry: SessionEntry): boolean {
	const message = (entry as { message?: { content?: unknown } }).message;
	return textOf(message?.content).trim().length > 0;
}

/** Base filter: only user statements and assistant text responses. */
function keepEntry(entry: SessionEntry): boolean {
	const role = roleOf(entry);
	return (role === "user" || role === "assistant") && hasText(entry);
}

function isAssistantNode(node: SessionTreeNode): boolean {
	return roleOf(node.entry) === "assistant";
}

/** Kept descendants of a node, re-attached to the nearest kept ancestor. */
function keptChildren(node: SessionTreeNode): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const child of node.children) {
		if (keepEntry(child.entry)) {
			out.push({ ...child, children: keptChildren(child) });
		} else {
			out.push(...keptChildren(child));
		}
	}
	return out;
}

/**
 * Collapse assistant chains: drop an assistant node that continues into
 * another assistant response (intermediate "working on it..." messages
 * around tool calls) as long as it is not itself the direct final response
 * of some branch (no direct user child).
 */
function collapseChains(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const node of nodes) {
		const children = collapseChains(node.children);
		if (isAssistantNode(node) && children.some(isAssistantNode) && !children.some(isUserNode)) {
			// Intermediate response: drop it, hoist its children to its parent.
			out.push(...children);
		} else {
			out.push({ ...node, children });
		}
	}
	return out;
}

function isUserNode(node: SessionTreeNode): boolean {
	return roleOf(node.entry) === "user";
}

function pruneTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (keepEntry(node.entry)) {
			out.push({ ...node, children: collapseChains(keptChildren(node)) });
		} else {
			out.push(...collapseChains(keptChildren(node)));
		}
	}
	return out;
}

/** Last conversation entry on the current branch (for initial selection). */
function nearestKeptId(sessionManager: { getBranch(): SessionEntry[] }): string | null {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		if (keepEntry(branch[i])) return branch[i].id;
	}
	return null;
}

type PreviewEntry = { id: string; role: "user" | "assistant"; title: string; text: string };

function previewEntry(node: SessionTreeNode): PreviewEntry {
	const role = roleOf(node.entry) === "user" ? "user" : "assistant";
	const text = textOf((node.entry as { message?: { content?: unknown } }).message?.content).trim();
	// Array.from so the title cut never splits a surrogate pair.
	const firstLine = Array.from(text.replace(/\s+/g, " ")).slice(0, 100).join("");
	return { id: node.entry.id, role, title: `${role}: ${firstLine}`, text };
}
/** Pre-order flatten of the pruned tree: the reading order of the preview. */
function flattenTree(nodes: SessionTreeNode[], out: PreviewEntry[] = []): PreviewEntry[] {
	for (const node of nodes) {
		out.push(previewEntry(node));
		flattenTree(node.children, out);
	}
	return out;
}

type TreeAction =
	| { kind: "select"; entryId: string }
	| { kind: "preview"; index: number }
	| { kind: "cancel" };

type PreviewResult = { kind: "close" | "chat"; index: number };

/** Full-screen read-only view of one conversation entry. */
class EntryPreview implements Component {
	private scroll = 0;
	// Wrapped lines, keyed by (entry, width) so scrolling never re-wraps. Cached
	// per key rather than cleared on redraw: an empty cache would make the scroll
	// bounds look like zero on the next keystroke.
	private wrappedFor?: { index: number; width: number; lines: string[] };

	constructor(
		private index: number,
		private readonly entries: PreviewEntry[],
		private readonly getRows: () => number,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (result: PreviewResult) => void,
	) {}

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done({ kind: "close", index: this.index });
			return;
		}
		if (data === "c") {
			this.done({ kind: "chat", index: this.index });
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const next = this.index + (matchesKey(data, Key.right) ? 1 : -1);
			if (next >= 0 && next < this.entries.length) {
				this.index = next;
				this.scroll = 0;
			}
			return;
		}

		const page = Math.max(1, this.bodyHeight() - 1);
		// Only the lower bound is applied here. The upper bound depends on the
		// wrapped height for the current width, which render() clamps against -
		// the one place it is known to be accurate.
		if (data === "j" || matchesKey(data, Key.down)) {
			this.scroll += 1;
		} else if (data === "k" || matchesKey(data, Key.up)) {
			this.scroll = Math.max(0, this.scroll - 1);
		} else if (data === " " || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
			this.scroll += page;
		} else if (data === "b" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
			this.scroll = Math.max(0, this.scroll - page);
		} else if (data === "g" || matchesKey(data, Key.home)) {
			this.scroll = 0;
		} else if (data === "G" || matchesKey(data, Key.end)) {
			this.scroll = Number.MAX_SAFE_INTEGER;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 4);
		const body = this.bodyHeight();
		const entry = this.entries[this.index];
		const content = this.wrapped(innerWidth);
		const max = Math.max(0, content.length - body);
		this.scroll = Math.max(0, Math.min(this.scroll, max));

		const position = `${this.index + 1}/${this.entries.length}`;
		const posWidth = visibleWidth(position);
		const title = truncateToWidth(entry.title, Math.max(10, innerWidth - posWidth - 2), "…");
		const help = this.theme.fg("dim", "←/→ entry • j/k line • Space/b page • g/G top/end • c chat • q close");

		const border = this.theme.fg("border", "─".repeat(safeWidth - 2));
		const lines = [`┌${border}┐`];
		lines.push(this.row(`${this.theme.fg("accent", title)}  ${this.theme.fg("dim", position)}`, innerWidth));
		lines.push(this.row(help, innerWidth));
		lines.push(`├${border}┤`);
		for (let i = 0; i < body; i++) {
			lines.push(this.row(content[this.scroll + i] ?? "", innerWidth));
		}
		lines.push(`└${border}┘`);
		return lines;
	}

	invalidate(): void {}

	private row(text: string, innerWidth: number): string {
		const clipped = truncateToWidth(text, innerWidth, "");
		return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} │`;
	}

	private bodyHeight(): number {
		return Math.max(1, this.getRows() - 5);
	}

	private wrapped(innerWidth: number): string[] {
		if (this.wrappedFor && this.wrappedFor.index === this.index && this.wrappedFor.width === innerWidth) {
			return this.wrappedFor.lines;
		}
		const text = this.entries[this.index].text;
		const lines = text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, innerWidth) : [""]));
		this.wrappedFor = { index: this.index, width: innerWidth, lines };
		return lines;
	}
}

/** ctrl+p previews the selected entry instead of typing into the search field. */
class PreviewTreeSelector extends TreeSelectorComponent {
	onPreview?: () => void;

	handleInput(keyData: string): void {
		if (matchesKey(keyData, PREVIEW_KEY)) {
			this.onPreview?.();
			return;
		}
		super.handleInput(keyData);
	}
}

/** Flat transcript for non-TUI modes, with the same chain collapsing. */
function plainTranscript(sessionManager: { getBranch(): SessionEntry[] }): string {
	const kept = sessionManager.getBranch().filter(keepEntry);
	const lines: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		const entry = kept[i];
		const message = (entry as { message: { role: string; content?: unknown; model?: string } }).message;
		// Skip assistant responses that are followed by another assistant
		// response before the next user statement.
		if (message.role === "assistant") {
			const next = kept[i + 1];
			if (next && roleOf(next) === "assistant") continue;
		}
		const time = entry.timestamp
			? new Date(entry.timestamp as string | number).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
			: "";
		const who = message.role === "user" ? "you" : (message.model ?? "assistant");
		lines.push(`[${time}] ${who}:\n${textOf(message.content).trim()}\n`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("utree", {
		description: "Conversation view (like /tree: user + final assistant responses only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				console.log(plainTranscript(ctx.sessionManager as never));
				return;
			}

			const tree = pruneTree(ctx.sessionManager.getTree() as SessionTreeNode[]);
			if (tree.length === 0) {
				ctx.ui.notify("Nothing to show on this branch yet", "warning");
				return;
			}
			const currentId = nearestKeptId(ctx.sessionManager as never);
			const entries = flattenTree(tree);
			let initialId = currentId;

			// Returns the action to run next: the picker again when navigation was
			// abandoned, undefined once the session actually moved.
			const navigate = async (entryId: string): Promise<TreeAction | undefined> => {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the agent to finish before navigating", "warning");
					return open();
				}
				// Mirror /tree's "Summarize branch?" prompt
				while (true) {
					const choice = await ctx.ui.select("Summarize branch?", [
						"No summary",
						"Summarize",
						"Summarize with custom prompt",
					]);
					if (choice === undefined) return open(); // escape -> back to the tree
					let customInstructions: string | undefined;
					if (choice === "Summarize with custom prompt") {
						customInstructions = await ctx.ui.editor("Custom summarization instructions");
						if (customInstructions === undefined) continue; // cancelled -> summary prompt again
					}
					const result = await ctx.navigateTree(entryId, {
						summarize: choice !== "No summary",
						customInstructions,
					});
					if (result.cancelled) {
						ctx.ui.notify("Navigation cancelled", "warning");
						return open();
					}
					return undefined;
				}
			};

			const open = (): Promise<TreeAction | undefined> =>
				ctx.ui.custom<TreeAction | undefined>((tui, _theme, _keybindings, done) => {
					const selector = new PreviewTreeSelector(
						tree,
						currentId,
						tui.terminal.rows || 40,
						(entryId: string) => done({ kind: "select", entryId }),
						() => done({ kind: "cancel" }),
						// Label changes are display-only here: extensions get a read-only
						// session manager, so they cannot persist label changes.
						() => {},
						initialId ?? undefined,
					);
					selector.onPreview = () => {
						const id = selector.getTreeList().getSelectedNode()?.entry.id;
						const index = id ? entries.findIndex((entry) => entry.id === id) : -1;
						if (index < 0) return; // nothing selected, e.g. a filter that matched nothing
						done({ kind: "preview", index });
					};
					return selector;
				});

			const run = async (): Promise<void> => {
				let action = await open();
				while (action && action.kind !== "cancel") {
					if (action.kind === "select") {
						action = await navigate(action.entryId);
						continue;
					}
					const previewIndex = action.index;
					const preview = await ctx.ui.custom<PreviewResult | undefined>(
						(tui, theme, _keybindings, done) =>
							new EntryPreview(previewIndex, entries, () => tui.terminal.rows, theme, (result) => done(result)),
						{
							overlay: true,
							overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
						},
					);
					if (!preview) return;
					if (preview.kind === "chat") {
						// Hand the entry to the editor as quoted context and leave the user
						// to type the follow-up: no prompt is sent on their behalf.
						const entry = entries[preview.index];
						const quote = entry.text
							.split("\n")
							.map((line) => (line ? `> ${line}` : ">"))
							.join("\n");
						ctx.ui.setEditorText(`Earlier ${entry.role} in this session:\n\n${quote}\n\nMy question: `);
						return;
					}
					// Reopen on the entry the preview stopped at, so paging does not
					// lose the place in the tree.
					initialId = entries[preview.index]?.id ?? initialId;
					action = await open();
				}
			};

			await run();
		},
	});
}
