// Claude Code Mod. Rendering and MCP calls stay inside the existing host; no model turn or web server.
const SERVER = 'plugin:memesh:memesh';
const PANE = 'memesh-memory';
// Left out, a pane gets a third of the terminal, which cuts a memory's text off below the actions.
const OPEN = { id: PANE, title: 'MeMesh memories', focus: true, closeOnEscape: true, rows: 24 };

// Words a person reads in place of the stored identifiers; anything unlisted is shown as stored.
const TYPE_NAMES = { decision: 'Decision', note: 'Note', lesson_learned: 'Lesson', pattern: 'Pattern', bug: 'Bug', 'task-state': 'Task state' };
const HOST_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', 'codex-mcp-client': 'Codex', cli: 'MeMesh CLI' };

let query = '';
let project;
let folder;
let memories = [];
let selected;
let draft;
let busy = false;
// tone is undefined (plain), 'success' or 'error'; the words carry the meaning, colour only confirms it.
let notice = { text: '' };

const call = async ($, tool, args) => {
  const result = await $.mcp.call(SERVER, tool, args);
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) throw new Error(text || 'MeMesh could not complete this operation.');
  return JSON.parse(text);
};
const run = async ($, action) => {
  if (busy) return;
  busy = true;
  notice = { text: '' };
  $.ui.invalidate('ui.render');
  try { await action(); }
  catch (error) {
    // A dropped reply may come after a commit, so promise nothing about the data: point to where to check, then the reason.
    const reason = (error instanceof Error ? error.message : '').replace(/\s+/g, ' ').trim();
    notice = { text: 'This did not finish. Reopen the memory to check what it holds now.', tone: 'error', detail: reason && `Reason: ${reason.length > 90 ? `${reason.slice(0, 89)}…` : reason}` };
  }
  finally { busy = false; $.ui.invalidate('ui.render'); }
};
const search = ($, value) => run($, async () => {
  query = value;
  selected = undefined;
  draft = undefined;
  const result = await call($, 'recall', { query, limit: 5 });
  project = result.scope?.project;
  // The first slice edits only the current project, never an implicitly selected global memory.
  memories = project ? result.entities.filter(memory => memory.projects?.includes(project)) : [];
  if (!project) notice = { text: 'This folder has no MeMesh project, so there are no memories to show. Open Claude Code in your project folder.', tone: 'error' };
  else if (!memories.length) notice = { text: query ? 'No memories match. Try other words.' : 'This project has no memories yet.' };
});
const edit = $ => run($, async () => {
  try {
    const result = await call($, 'remember', { name: selected.name, project, interactive: true });
    if (result.status === 'saved') {
      selected = { ...selected, title: result.memory.title, observations: [result.memory.body], truncated: undefined };
      memories = memories.map(memory => memory.name === selected.name ? selected : memory);
      notice = { text: '✓ Saved. Below is the text read back from the database.', tone: 'success' };
    } else if (result.status === 'cancelled') notice = { text: 'Cancelled. Nothing was changed.' };
    else notice = { text: 'Nothing changed, so nothing was saved.' };
  } finally {
    // Closing the form hands the keys to the prompt, whatever it ended in; ask for them back for the pane.
    await $.ui.open(OPEN);
  }
});
const editInPane = $ => run($, async () => {
  const result = await call($, 'remember', { name: selected.name, project, editor: { action: 'prepare' } });
  selected = { ...selected, ...result.memory, truncated: undefined };
  draft = { revision: result.revision, memory: result.memory, title: '', observations: result.memory.observations.map(() => '') };
});
const saveInPane = $ => run($, async () => {
  const { memory, revision, title, observations } = draft;
  const result = await call($, 'remember', { name: memory.name, project, editor: {
    action: 'save', revision,
    title: title.trim() ? title : memory.title,
    observations: observations.map((text, index) => text.trim() ? text : memory.observations[index]),
  } });
  selected = { ...selected, ...result.memory, truncated: undefined };
  memories = memories.map(memory => memory.name === selected.name ? selected : memory);
  draft = undefined;
  notice = result.status === 'saved'
    ? { text: '✓ Saved. Below is the text read back from the database.', tone: 'success' }
    : { text: 'Nothing changed, so nothing was saved.' };
});

export function register(on) {
  on('session.start', async ($, event, next) => {
    // The plugin's skill already owns /memesh (as /memesh:memesh), so the pane takes its own name.
    await $.command.register({ name: 'memesh-memories', description: 'View and edit this project’s MeMesh memories' });
    return next(event);
  });
  on('command.run', { command: 'memesh-memories' }, async ($, event) => {
    try {
      folder = await $.session.cwd();
      await $.ui.open(OPEN);
    } catch (error) {
      return { text: `Could not open the MeMesh memories pane: ${error instanceof Error ? error.message : 'unknown reason'}` };
    }
    await search($, event.args.trim());
    return {};
  });
  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    if (event.requestId !== PANE) return next(event);
    const { Box, Text, Button, Input } = $.ui.resolve(event);
    const redraw = () => $.ui.invalidate('ui.render');
    const typeName = memory => TYPE_NAMES[memory.type] || memory.type;
    const day = memory => memory.created_at?.slice(0, 10) || 'date not recorded';
    const oneLine = text => {
      const flat = (text || '').replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
    };
    const hint = text => Text({ children: [text], dimColor: true });
    const where = folder && [
      Text({ children: ['Project folder: ', Text({ children: [folder.split('/').filter(Boolean).at(-1) || folder], bold: true })] }),
      // The full path only where there is room to spare: the list, not an open memory.
      ...(selected ? [] : [hint(folder.replace(/^\/(Users|home)\/[^/]+/, '~'))]),
    ];
    const source = selected?.metadata?.provenance?.source_host;
    const updateTitle = value => { if (!busy && draft) draft.title = value; };
    const detail = selected && [
      Text({ children: [selected.title || typeName(selected)], bold: true }),
      Text({ children: [`${typeName(selected)} · created ${day(selected)} · `,
        source ? Text({ children: [`written by ${HOST_NAMES[source] || source}`] }) : Text({ children: ['source not recorded'], color: 'warning' })], dimColor: true }),
      // Actions sit above the text: a pane is only so tall, and a long memory would push them out of view.
      Box({ flexDirection: 'row', gap: 2, marginTop: 1, children: draft ? [
        Button({ key: 'memesh-save', label: 'Save changes', hotkey: 's', variant: 'primary', onPress: () => { void saveInPane($); } }),
        Button({ key: 'memesh-cancel', label: 'Cancel', hotkey: 'c', onPress: () => {
          if (!busy) { draft = undefined; notice = { text: 'Cancelled. Your edits were not saved.' }; redraw(); }
        } }),
      ] : [
        // The form waits on a person; a press hook has 10 seconds, so the edit runs on and redraws when it settles.
        Button({ key: 'memesh-edit', label: 'Edit this memory', hotkey: 'e', variant: 'primary', onPress: () => {
          if (event.surface === 'desktop') void editInPane($);
          else void edit($);
        } }),
        Button({ key: 'memesh-back', label: 'Back to list', hotkey: 'b', onPress: () => { if (!busy) { selected = undefined; notice = { text: '' }; redraw(); } } }),
      ] }),
      hint(draft ? 'Fill only what you want to change; blank keeps the original. Save changes or Cancel above.'
        : event.surface === 'desktop' ? 'e edit in this pane · b back to list · Esc close'
          : 'e edit · b back to list · Esc close'),
      ...(!draft && event.surface !== 'desktop' ? [hint('Edit opens a form: fill in only what you want to change, blank keeps the original; Accept saves, Esc cancels.')] : []),
      ...(draft ? [
        Input({ key: 'memesh-title', label: 'New title (blank keeps original)', value: draft.title, autoFocus: true, submitLabel: 'keep editing',
          onInput: updateTitle, onSubmit: updateTitle }),
        ...draft.observations.map((text, index) => {
          const update = value => { if (!busy && draft) draft.observations[index] = value; };
          return Input({ key: `memesh-paragraph-${index}`, label: `Paragraph ${index + 1} (blank keeps original)`, value: text, submitLabel: 'keep editing', onInput: update, onSubmit: update });
        }),
      ] : []),
      Box({ borderStyle: 'round', borderDimColor: true, paddingX: 1, children: [Text({ children: [selected.observations.join('\n\n')] })] }),
      ...(selected.truncated ? [hint('Only part is shown here; Edit loads the full text.')] : []),
    ];
    const results = memories.map((memory, index) => Box({ flexDirection: 'column', children: [
      Button({ key: `memesh-memory-${index}`, plain: true, hotkey: String(index + 1), label: memory.title || typeName(memory),
        onPress: () => { selected = memory; notice = { text: '' }; redraw(); } }),
      Text({ children: [`   ${typeName(memory)} · ${day(memory)} — ${oneLine(memory.observations?.[0])}`], dimColor: true, wrap: 'truncate-end' }),
    ] }));
    const list = memories.length
      ? [Text({ children: [`Found ${memories.length}. Press a number to open:`] }), ...results, hint('Esc to close')]
      : [];
    return Box({ flexDirection: 'column', children: [
      ...(where || []),
      ...(!draft ? [Box({ marginTop: 1, children: [Input({ key: 'memesh-search', label: 'Search', placeholder: 'type words and press Enter; leave empty for recent memories', value: query, submitLabel: 'search',
        onInput: value => { query = value; }, onSubmit: value => search($, value) })] })] : []),
      // Status sits above the results for the same reason as the actions.
      ...(busy || notice.text ? [Text({ children: [busy ? 'Working…' : notice.text], ...(notice.tone && !busy ? { color: notice.tone } : { dimColor: true }) })] : []),
      ...(!busy && notice.detail ? [hint(notice.detail)] : []),
      Box({ flexDirection: 'column', marginTop: 1, children: detail || list }),
    ] });
  });
}
