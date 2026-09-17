const loader = String.raw`(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-ai-caller-key');
  if (!key) return;
  var marker = 'ai-caller-widget-' + key;
  if (document.getElementById(marker)) return;

  var origin = new URL(script.src).origin;
  var root = document.createElement('div');
  root.id = marker;
  root.style.position = 'fixed';
  root.style.right = '20px';
  root.style.bottom = '20px';
  root.style.zIndex = '2147483000';
  root.style.fontFamily = 'Inter, ui-sans-serif, system-ui, sans-serif';

  var frame = document.createElement('iframe');
  frame.src = origin + '/widget/' + encodeURIComponent(key);
  frame.title = 'Business chat';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.style.width = 'min(390px, calc(100vw - 24px))';
  frame.style.height = 'min(640px, calc(100vh - 100px))';
  frame.style.border = '0';
  frame.style.borderRadius = '20px';
  frame.style.boxShadow = '0 20px 60px rgba(15, 23, 42, .22)';
  frame.style.background = '#fff';
  frame.style.display = 'none';
  frame.style.marginBottom = '12px';

  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Open chat');
  button.textContent = 'Chat';
  button.style.cssText = 'float:right;border:0;border-radius:999px;background:#173c86;color:white;font:600 15px/1 system-ui,sans-serif;padding:16px 20px;box-shadow:0 10px 30px rgba(23,60,134,.28);cursor:pointer;';

  function setOpen(open) {
    frame.style.display = open ? 'block' : 'none';
    button.textContent = open ? 'Close' : 'Chat';
    button.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  }

  button.addEventListener('click', function () { setOpen(frame.style.display === 'none'); });
  window.addEventListener('message', function (event) {
    if (event.origin === origin && event.data && event.data.type === 'ai-caller-close') setOpen(false);
  });

  root.appendChild(frame);
  root.appendChild(button);
  document.body.appendChild(root);
})();`;

export async function GET() {
  return new Response(loader, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
