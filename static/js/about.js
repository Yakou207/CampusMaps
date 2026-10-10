// Suggestion form on the About page: checks input in the browser, sends it to
// POST /api/suggestions, and shows the server's field errors if it rejects anything.
import { saveSuggestion } from './api.js';

const form = document.getElementById('suggest-form');
const done = document.getElementById('suggest-done');
const status = document.getElementById('suggest-status');
const submit = form.querySelector('button[type="submit"]');
const fields = {
  kind: form.querySelector('.kind-field'),
  canteen_id: form.elements.canteen_id,
  stall_name: form.elements.stall_name,
  message: form.elements.message,
  contact: form.elements.contact,
};
const counter = form.querySelector('[data-count]');
let attempted = false;

// prefill from links such as /about?canteen=c08&stall=xx&kind=correction#suggest
const params = new URLSearchParams(location.search);
if (params.get('canteen') && [...fields.canteen_id.options].some((o) => o.value === params.get('canteen'))) {
  fields.canteen_id.value = params.get('canteen');
}
const kindParam = params.get('kind') || (params.get('canteen') ? 'new_stall' : '');
const kindInput = form.querySelector(`input[name="kind"][value="${CSS.escape(kindParam)}"]`);
if (kindInput) kindInput.checked = true;
if (params.get('stall')) fields.stall_name.value = params.get('stall').slice(0, 40);
updateKind();

function values() {
  return {
    kind: form.elements.kind.value,
    canteen_id: fields.canteen_id.value,
    stall_name: fields.stall_name.value.trim(),
    message: fields.message.value.trim(),
    contact: fields.contact.value.trim(),
  };
}

function check(v) {
  const errors = {};
  if (!v.kind) errors.kind = '请选择一项 · Choose one of the options.';
  if (v.kind === 'new_stall' && !v.stall_name) errors.stall_name = '请填写摊位名称 · Tell us the stall’s name.';
  if (v.message.length < 5) errors.message = '请多写几个字（至少 5 个字）· Add a little more detail (5+ characters).';
  return errors;
}

function showErrors(errors) {
  for (const [name, el] of Object.entries(fields)) {
    const msg = errors[name] || '';
    document.getElementById(`err-${name}`).textContent = msg;
    if (msg) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }
}

function updateKind() {
  const required = form.elements.kind.value === 'new_stall';
  document.getElementById('stall-req').hidden = !required;
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'kind') updateKind();
  if (attempted) showErrors(check(values()));
});
form.addEventListener('input', (e) => {
  if (e.target === fields.message) counter.textContent = fields.message.value.length;
  if (attempted) showErrors(check(values()));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  attempted = true;
  status.className = 'form-status';
  status.textContent = '';
  const v = values();
  const errors = check(v);
  showErrors(errors);
  if (Object.keys(errors).length) {
    const first = Object.keys(fields).find((k) => errors[k]);
    (first === 'kind' ? form.querySelector('input[name="kind"]') : fields[first]).focus();
    return;
  }
  submit.disabled = true;
  submit.classList.add('is-loading');
  try {
    await saveSuggestion(v);
    form.hidden = true;
    done.hidden = false;
    done.focus();
  } catch (err) {
    showErrors(err.errors || {});
    status.className = 'form-status is-error';
    status.textContent = err.errors?.form || err.errors?.client || (Object.keys(err.errors || {}).length
      ? '有几处需要修改，见上方提示 · A few fields need fixing — see above.' : err.message);
  } finally {
    submit.disabled = false;
    submit.classList.remove('is-loading');
  }
});

document.getElementById('suggest-again').addEventListener('click', () => {
  form.reset();
  attempted = false;
  showErrors({});
  counter.textContent = '0';
  updateKind();
  done.hidden = true;
  form.hidden = false;
  form.querySelector('input[name="kind"]').focus();
});
