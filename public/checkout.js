// Checkout: show summary, validate, create order, hand off to eSewa.
let total = 0;

async function init() {
  if (Cart.count() === 0) { location.href = '/'; return; }
  const products = await api('/api/products');
  const lines = Cart.read()
    .map((i) => ({ ...i, product: products.find((p) => p.id === i.id) }))
    .filter((l) => l.product);

  document.getElementById('summary-lines').replaceChildren(
    ...lines.map((l) =>
      el('div', { class: 'summary-line' },
        el('div', { class: 'cart-thumb' }, productImage(l.product, '56px')),
        el('div', { class: 'summary-line-info' },
          el('span', {}, l.product.name),
          el('span', { class: 'muted' }, `${l.qty} × ${formatNpr(l.product.price)}`)
        ),
        el('span', {}, formatNpr(l.product.price * l.qty))
      )
    )
  );
  // Display only. The server recalculates the real total from the database.
  total = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
  document.getElementById('summary-total').textContent = formatNpr(total);
  document.getElementById('pay-button').textContent = `Pay ${formatNpr(total)} with eSewa`;
}

function showError(msg) {
  const box = document.getElementById('form-error');
  box.textContent = msg;
  box.hidden = !msg;
}

document.getElementById('checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  showError('');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const data = new FormData(form);
  const button = document.getElementById('pay-button');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening eSewa…';

  try {
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        items: Cart.read(),
        customer: {
          name: data.get('name'), email: data.get('email'),
          phone: data.get('phone'), address: data.get('address'),
        },
      }),
    });

    // eSewa needs a real form POST, so fill the hidden form and submit it.
    const f = document.getElementById('esewa-form');
    f.action = result.form.action;
    f.replaceChildren(
      ...Object.entries(result.form.fields).map(([name, value]) => el('input', { type: 'hidden', name, value }))
    );
    f.submit();
  } catch (err) {
    showError(err.message);
    button.disabled = false;
    button.textContent = label;
  }
});

init().catch((err) => showError(err.message));
