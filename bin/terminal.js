import { emitKeypressEvents, moveCursor, cursorTo, clearScreenDown } from 'node:readline';

export class Cancelled extends Error {}

// Small terminal UI using only Node built-ins. Keep all input ownership here so
// raw mode and event listeners are released before npm handles authentication.
export function prompt({ type, message, choices = [], initial, validate }) {
  const input = process.stdin;
  const output = process.stdout;
  if (input.readableEnded) return Promise.reject(new Error('Input closed. Setup cancelled before making changes.'));
  const multiple = type === 'multiselect';
  const selecting = multiple || type === 'select';
  const selected = new Set();
  let text = '', touched = false, cursor = 0, rows = 0, error = '';
  let visible = choices;
  const wasRaw = input.isRaw || false;
  return new Promise((resolve, reject) => {
    const render = () => {
      const lines = [`? ${message}${type === 'confirm' ? ' [y/N]' : initial && !touched ? ` [${initial}]` : ''}`, `  ${selecting ? 'Filter: ' : '> '}${text}`];
      if (selecting) {
        lines.push(multiple ? '  ↑/↓ move · Space select/unselect · type to filter · Enter confirm' : '  ↑/↓ move · type to filter · Enter confirm');
        const start = Math.max(0, cursor - 9);
        for (const [index, choice] of visible.slice(start, start + 10).entries()) {
          lines.push(`${index + start === cursor ? '❯' : ' '} ${multiple ? selected.has(choice.value) ? '◉ ' : '◯ ' : ''}${choice.title}`);
        }
        if (!visible.length) lines.push('  No matches for this query.');
        if (multiple) lines.push(`  ${selected.size} selected (including hidden choices)`);
      }
      if (error) lines.push(`  ${error}`);
      if (output.isTTY && rows) {
        moveCursor(output, 0, -rows);
        cursorTo(output, 0);
        clearScreenDown(output);
      }
      output.write(lines.join('\n') + '\n');
      const width = output.columns || 80;
      rows = lines.reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / width)), 0);
    };
    const finish = (value, failure) => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
      failure ? reject(failure) : resolve(value);
    };
    const onEnd = () => finish(undefined, new Error('Input closed. Setup cancelled before making changes.'));
    const submit = value => {
      const result = validate?.(value);
      if (result !== undefined && result !== true) {
        error = typeof result === 'string' ? result : 'Enter a valid value.';
        return render();
      }
      finish(value);
    };
    const onKey = (character, key = {}) => {
      error = '';
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') return finish(undefined, new Cancelled());
      if (type === 'confirm' && /^[yn]$/i.test(character || '')) return finish(character.toLowerCase() === 'y');
      if (['return', 'enter'].includes(key.name)) {
        if (type === 'confirm') return finish(Boolean(initial));
        if (!selecting) return submit(touched ? text : initial || '');
        if (multiple && !selected.size) error = 'Select at least one package.';
        else if (multiple) return finish(choices.filter(choice => selected.has(choice.value)).map(choice => choice.value));
        else if (visible[cursor]) return finish(visible[cursor].value);
        else error = 'Select a matching choice.';
        return render();
      }
      if (selecting && ['up', 'down'].includes(key.name)) {
        if (visible.length) cursor = (cursor + (key.name === 'up' ? -1 : 1) + visible.length) % visible.length;
      } else if (multiple && (character === ' ' || ['left', 'right'].includes(key.name))) {
        const choice = visible[cursor];
        if (choice) {
          if (key.name === 'left' || (character === ' ' && selected.has(choice.value))) selected.delete(choice.value);
          else selected.add(choice.value);
        }
      } else if (['backspace', 'delete'].includes(key.name)) {
        if (!selecting && !touched) text = initial || '';
        text = [...text].slice(0, -1).join('');
        touched = true;
        cursor = 0;
      } else if (key.ctrl && key.name === 'u') {
        text = '';
        touched = true;
        cursor = 0;
      } else if (character && !key.ctrl && !key.meta && !character.startsWith('\x1b')) {
        text += character;
        touched = true;
        cursor = 0;
      }
      if (selecting) visible = choices.filter(choice => choice.title.toLowerCase().includes(text.toLowerCase()));
      render();
    };
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    render();
  });
}
