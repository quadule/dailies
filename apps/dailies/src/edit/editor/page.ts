// The HTML shell `dailies cut edit` serves at "/". Everything visible is
// rendered by the client bundle (/editor.js) into #app; this only names the
// session and loads the bundle and its stylesheet.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export function editorPage(args: { sessionName: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(args.sessionName)} · Dailies editor</title>
<link rel="stylesheet" href="/editor.css">
<script src="/editor.js" defer></script>
</head>
<body>
<div id="app"></div>
<noscript>The Dailies editor needs JavaScript.</noscript>
</body>
</html>
`;
}
