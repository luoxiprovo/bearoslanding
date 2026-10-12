const form = document.querySelector('#inquiry');
const status = document.querySelector('#form-status');
const success = document.querySelector('#form-success');
const submit = document.querySelector('#send');
const copyButton = document.querySelector('#copy-install');
const command = document.querySelector('#install-command');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = '';
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  const previous = submit.textContent;
  submit.textContent = 'Sending…';

  const data = Object.fromEntries(new FormData(form));

  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      status.textContent = body.error || 'We could not send your message.';
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = previous;
      return;
    }
    form.hidden = true;
    success.hidden = false;
    success.querySelector('h3').focus();
  } catch {
    status.textContent = 'We could not reach the server. Try again.';
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    submit.textContent = previous;
  }
});

copyButton.addEventListener('click', async () => {
  const text = command.textContent.trim();
  let label = 'Copied';
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    label = document.execCommand('copy') ? 'Copied' : 'Selected';
  }
  copyButton.textContent = label;
  window.setTimeout(() => {
    copyButton.textContent = 'Copy';
  }, 2000);
});
