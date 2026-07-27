const state = { products: [], clients: [], quotes: [], cart: [] };
const money = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ', minimumFractionDigits: 2 });
const $ = (selector) => document.querySelector(selector);

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  $('#quote-date').value = new Date().toISOString().slice(0, 10);
  bindEvents();
  await Promise.all([loadHealth(), loadProducts(), loadClients(), loadQuotes()]);
  renderCart();
}

function bindEvents() {
  document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => showSection(button.dataset.section)));
  document.querySelectorAll('[data-open-modal]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.openModal)));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  $('#product-search').addEventListener('input', renderProducts);
  $('#product-form').addEventListener('submit', saveProduct);
  $('#client-form').addEventListener('submit', saveClient);
  $('#clear-cart').addEventListener('click', clearCart);
  $('#save-quote').addEventListener('click', saveQuote);
  $('#refresh-quotes').addEventListener('click', loadQuotes);
  $('#product-list').addEventListener('click', handleProductAction);
  $('#client-list').addEventListener('click', handleClientAction);
  $('#cart-body').addEventListener('click', handleCartAction);
  $('#quote-list').addEventListener('click', handleQuoteAction);
  $('#quote-preview-modal').addEventListener('click', (event) => { if (event.target === $('#quote-preview-modal')) $('#quote-preview-modal').close(); });
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const content = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(content.message || 'No se pudo completar la operación.');
  return content;
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const badge = $('#connection-status');
    badge.className = `connection ${health.mode}`;
    badge.textContent = health.mode === 'mysql' ? `MySQL · ${health.database}` : 'Modo local · MySQL no disponible';
  } catch { $('#connection-status').textContent = 'Sin conexión'; }
}

async function loadProducts() {
  try { state.products = await api('/api/productos'); renderProducts(); renderCart(); } catch (error) { notify(error.message, 'error'); }
}

async function loadClients() {
  try { state.clients = await api('/api/clientes'); renderClients(); renderClientSelect(); } catch (error) { notify(error.message, 'error'); }
}

async function loadQuotes() {
  try { state.quotes = await api('/api/cotizaciones'); renderQuotes(); } catch (error) { notify(error.message, 'error'); }
}

function showSection(section) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === section));
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.section === section));
  if (section === 'historial') loadQuotes();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(modalId) {
  if (modalId === 'product-modal') $('#product-form').reset();
  if (modalId === 'client-modal') prepareNewClient();
  const modal = $(`#${modalId}`);
  if (!modal.open) modal.showModal();
}

function closeModal(modalId) { const modal = $(`#${modalId}`); if (modal.open) modal.close(); }

function renderProducts() {
  const query = $('#product-search').value.trim().toLocaleLowerCase();
  const products = state.products.filter((product) => `${product.codigo} ${product.nombre} ${product.descripcion || ''}`.toLocaleLowerCase().includes(query));
  $('#product-total').textContent = `${products.length} de ${state.products.length} productos`;
  $('#product-list').innerHTML = products.map((product) => `
    <article class="product-card">
      <span class="product-code">${escapeHtml(product.codigo)}</span>
      <h2>${escapeHtml(product.nombre)}</h2>
      <p>${escapeHtml(product.descripcion || 'Sin descripción.')}</p>
      <div class="product-bottom"><strong class="price">${formatMoney(product.precio)}</strong>
        <div class="card-actions"><button class="small-button add" data-action="add" data-id="${product.id}">Agregar</button><button class="small-button danger" data-action="delete" data-id="${product.id}" title="Eliminar producto">Eliminar</button></div>
      </div>
    </article>`).join('');
  $('#product-empty').classList.toggle('hidden', products.length > 0);
}

async function handleProductAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const id = Number(button.dataset.id); const product = state.products.find((item) => item.id === id); if (!product) return;
  if (button.dataset.action === 'add') { addToCart(product); return; }
  if (button.dataset.action === 'delete') {
    if (!confirm(`¿Eliminar “${product.nombre}” del catálogo?`)) return;
    try { await api(`/api/productos/${id}`, { method: 'DELETE' }); state.cart = state.cart.filter((item) => item.productoId !== id); await loadProducts(); notify('Producto eliminado.', 'success'); }
    catch (error) { notify(error.message, 'error'); }
  }
}

async function saveProduct(event) {
  event.preventDefault();
  const button = $('#product-form .primary'); button.disabled = true;
  try {
    await api('/api/productos', { method: 'POST', body: JSON.stringify({ codigo: $('#product-code').value, nombre: $('#product-name').value, descripcion: $('#product-description').value, precio: $('#product-price').value }) });
    closeModal('product-modal'); await loadProducts(); notify('Producto agregado al catálogo.', 'success');
  } catch (error) { notify(error.message, 'error'); } finally { button.disabled = false; }
}

function renderClients() {
  $('#client-total').textContent = `${state.clients.length} total`;
  $('#client-list').innerHTML = state.clients.map((client) => `
    <article class="client-row"><div><div class="client-name">${escapeHtml(client.nombre)}</div><div class="client-detail">${[client.telefono, client.correo, client.direccion].filter(Boolean).map(escapeHtml).join(' · ') || 'Sin datos de contacto adicionales'}</div></div>
      <div class="client-actions"><button class="small-button" data-action="edit" data-id="${client.id}">Editar</button><button class="small-button danger" data-action="delete" data-id="${client.id}">Eliminar</button></div>
    </article>`).join('');
  $('#client-empty').classList.toggle('hidden', state.clients.length > 0);
}

function renderClientSelect() {
  const select = $('#quote-client'); const current = select.value;
  select.innerHTML = '<option value="">Selecciona un cliente</option>' + state.clients.map((client) => `<option value="${client.id}">${escapeHtml(client.nombre)}</option>`).join('');
  select.value = state.clients.some((client) => String(client.id) === current) ? current : '';
}

function prepareNewClient() {
  $('#client-form').reset(); $('#client-id').value = ''; $('#client-modal-title').textContent = 'Nuevo cliente';
}

function editClient(client) {
  $('#client-id').value = client.id; $('#client-name').value = client.nombre; $('#client-phone').value = client.telefono || ''; $('#client-email').value = client.correo || ''; $('#client-address').value = client.direccion || '';
  $('#client-modal-title').textContent = 'Editar cliente'; $('#client-modal').showModal();
}

async function handleClientAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const id = Number(button.dataset.id); const client = state.clients.find((item) => item.id === id); if (!client) return;
  if (button.dataset.action === 'edit') return editClient(client);
  if (button.dataset.action === 'delete') {
    if (!confirm(`¿Eliminar a “${client.nombre}”?`)) return;
    try { await api(`/api/clientes/${id}`, { method: 'DELETE' }); await loadClients(); notify('Cliente eliminado.', 'success'); } catch (error) { notify(error.message, 'error'); }
  }
}

async function saveClient(event) {
  event.preventDefault();
  const id = $('#client-id').value; const button = $('#client-form .primary'); button.disabled = true;
  const data = { nombre: $('#client-name').value, telefono: $('#client-phone').value, correo: $('#client-email').value, direccion: $('#client-address').value };
  try {
    const saved = await api(id ? `/api/clientes/${id}` : '/api/clientes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeModal('client-modal'); await loadClients(); $('#quote-client').value = String(saved.id); notify(id ? 'Cliente actualizado.' : 'Cliente registrado.', 'success');
  } catch (error) { notify(error.message, 'error'); } finally { button.disabled = false; }
}

function addToCart(product) {
  const found = state.cart.find((item) => item.productoId === product.id);
  if (found) found.cantidad += 1;
  else state.cart.push({ productoId: product.id, codigo: product.codigo, nombre: product.nombre, precio: Number(product.precio), cantidad: 1 });
  renderCart(); notify(`${product.nombre} agregado.`, 'success');
}

function renderCart() {
  const totalItems = state.cart.reduce((total, item) => total + item.cantidad, 0);
  const total = state.cart.reduce((sum, item) => sum + item.precio * item.cantidad, 0);
  $('#cart-count').textContent = totalItems; $('#item-total').textContent = `${totalItems} artículo${totalItems === 1 ? '' : 's'}`; $('#quote-total').textContent = formatMoney(total);
  $('#cart-body').innerHTML = state.cart.map((item) => `<tr><td><span class="cart-product">${escapeHtml(item.nombre)}</span><span class="cart-code">${escapeHtml(item.codigo)}</span></td><td class="center"><div class="quantity-control"><button data-action="decrease" data-id="${item.productoId}">−</button><span>${item.cantidad}</span><button data-action="increase" data-id="${item.productoId}">+</button></div></td><td class="right">${formatMoney(item.precio)}</td><td class="right"><strong>${formatMoney(item.precio * item.cantidad)}</strong></td><td class="right"><button class="remove-item" data-action="remove" data-id="${item.productoId}">Quitar</button></td></tr>`).join('');
  $('#cart-empty').classList.toggle('hidden', state.cart.length > 0);
}

function handleCartAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const id = Number(button.dataset.id); const item = state.cart.find((entry) => entry.productoId === id); if (!item) return;
  if (button.dataset.action === 'increase') item.cantidad += 1;
  if (button.dataset.action === 'decrease') item.cantidad -= 1;
  if (button.dataset.action === 'remove' || item.cantidad < 1) state.cart = state.cart.filter((entry) => entry.productoId !== id);
  renderCart();
}

function clearCart() {
  if (!state.cart.length) return;
  if (!confirm('¿Vaciar los productos de esta cotización?')) return;
  state.cart = []; renderCart();
}

async function saveQuote() {
  const button = $('#save-quote'); button.disabled = true;
  try {
    const quote = await api('/api/cotizaciones', { method: 'POST', body: JSON.stringify({ clienteId: $('#quote-client').value, fechaCotizacion: $('#quote-date').value, estado: $('#quote-status').value, notas: $('#quote-notes').value, items: state.cart.map((item) => ({ productoId: item.productoId, cantidad: item.cantidad })) }) });
    state.cart = []; $('#quote-notes').value = ''; $('#quote-status').value = 'Borrador'; renderCart(); await loadQuotes(); notify(`Cotización ${quote.codigoCotizacion} guardada.`, 'success'); openQuotePreview(quote);
  } catch (error) { notify(error.message, 'error'); } finally { button.disabled = false; }
}

function renderQuotes() {
  $('#quote-list').innerHTML = state.quotes.map((quote) => `<article class="history-card"><div><div class="history-code">${escapeHtml(quote.codigoCotizacion)}</div><h2>${escapeHtml(quote.clienteNombre)}</h2><div class="history-meta">${formatDate(quote.fechaCotizacion)} · ${quote.items.length} artículo${quote.items.length === 1 ? '' : 's'}${quote.notas ? ` · ${escapeHtml(truncate(quote.notas, 65))}` : ''}</div></div><div class="history-right"><span class="status ${escapeHtml(quote.estado)}">${escapeHtml(quote.estado)}</span><strong class="history-total">${formatMoney(quote.total)}</strong><div class="history-actions"><button class="small-button" data-action="preview" data-id="${quote.id}">Ver / imprimir</button><button class="small-button danger" data-action="delete" data-id="${quote.id}">Eliminar</button></div></div></article>`).join('');
  $('#quote-empty').classList.toggle('hidden', state.quotes.length > 0);
}

async function handleQuoteAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const quote = state.quotes.find((item) => item.id === Number(button.dataset.id)); if (!quote) return;
  if (button.dataset.action === 'preview') return openQuotePreview(quote);
  if (button.dataset.action === 'delete') {
    if (!confirm(`¿Eliminar la cotización ${quote.codigoCotizacion}?`)) return;
    try { await api(`/api/cotizaciones/${quote.id}`, { method: 'DELETE' }); await loadQuotes(); notify('Cotización eliminada.', 'success'); } catch (error) { notify(error.message, 'error'); }
  }
}

function openQuotePreview(quote) {
  $('#quote-preview').innerHTML = `<div class="preview-top"><div><div class="preview-brand">TECNISOLUCIONES</div><span>Soluciones tecnológicas · Cotización comercial</span></div><div class="preview-code">${escapeHtml(quote.codigoCotizacion)}<br><small>${escapeHtml(quote.estado)}</small></div></div><div class="preview-client"><div><span class="preview-label">Cliente</span><strong>${escapeHtml(quote.clienteNombre)}</strong><br><span>${escapeHtml(quote.clienteTelefono || '')}</span></div><div><span class="preview-label">Fecha</span><strong>${formatDate(quote.fechaCotizacion)}</strong></div></div><table class="preview-items"><thead><tr><th>Producto</th><th class="center">Cant.</th><th class="right">Precio</th><th class="right">Subtotal</th></tr></thead><tbody>${quote.items.map((item) => `<tr><td>${escapeHtml(item.nombre)}<br><small>${escapeHtml(item.codigo)}</small></td><td class="center">${item.cantidad}</td><td class="right">${formatMoney(item.precioUnitario)}</td><td class="right">${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table><div class="preview-total">Total: ${formatMoney(quote.total)}</div>${quote.notas ? `<div class="preview-notes"><strong>Notas</strong><br>${escapeHtml(quote.notas)}</div>` : ''}<div class="preview-actions"><button class="button secondary" id="close-preview">Cerrar</button><button class="button primary" id="print-quote">Imprimir / Guardar PDF</button></div>`;
  const modal = $('#quote-preview-modal'); if (!modal.open) modal.showModal();
  $('#close-preview').addEventListener('click', () => modal.close()); $('#print-quote').addEventListener('click', () => window.print());
}

function formatMoney(value) { return money.format(Number(value) || 0).replace('GTQ', 'Q'); }
function formatDate(value) { if (!value) return 'Sin fecha'; const [year, month, day] = String(value).slice(0, 10).split('-'); return new Intl.DateTimeFormat('es-GT', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(Number(year), Number(month) - 1, Number(day))); }
function truncate(value, max) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
let toastTimer;
function notify(message, type = 'success') { const toast = $('#toast'); toast.textContent = message; toast.className = `toast ${type} show`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3800); }
