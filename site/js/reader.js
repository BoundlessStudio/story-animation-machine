// Story prose: a small, safe Markdown subset rendered straight to DOM nodes (never innerHTML).

function inline(parent, text) {
  // **bold**, *italic* and _italic_; everything else is literal text.
  const pattern = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w]))/g;
  let at = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > at) parent.append(text.slice(at, match.index));
    const node = document.createElement(match[2] !== undefined ? 'strong' : 'em');
    inline(node, match[2] ?? match[3] ?? match[4]);
    parent.append(node);
    at = match.index + match[0].length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

// As in Markdown, a single newline is only how the source was wrapped; a line that ends in two
// spaces (or a backslash) is a real break.
function lines(parent, text) {
  text.split(/ {2,}\n|\\\n/).forEach((line, index) => {
    if (index) parent.append(document.createElement('br'));
    inline(parent, line.replace(/\s*\n\s*/g, ' '));
  });
}

export function renderProse(markdown) {
  const out = document.createDocumentFragment();
  for (const raw of markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^(\*\s*\*\s*\*|-{3,}|_{3,}|#\s*$|⁂|\*{3,})$/.test(block)) { out.append(document.createElement('hr')); continue; }
    const heading = block.match(/^#{1,6}\s+(.+)$/);
    if (heading && !block.includes('\n')) {
      const node = document.createElement('h3');
      inline(node, heading[1]);
      out.append(node);
      continue;
    }
    if (block.startsWith('>')) {
      const node = document.createElement('blockquote');
      for (const part of block.replace(/^>[ \t]?/gm, '').split(/\n{2,}/)) {
        if (!part.trim()) continue;
        const line = document.createElement('p');
        lines(line, part.trim());
        node.append(line);
      }
      out.append(node);
      continue;
    }
    const node = document.createElement('p');
    lines(node, block);
    out.append(node);
  }
  return out;
}
