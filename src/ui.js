// Small "i" buttons with an explanation that shows instantly on hover or keyboard focus.
// One shared tooltip element, positioned next to the button and kept inside the viewport.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export const tip = (text) => `<button type="button" class="tip" aria-label="${esc(text)}" data-tip="${esc(text)}">i</button>`;

export function initTips() {
  const box = document.createElement("div");
  box.className = "tip-box";
  box.setAttribute("role", "tooltip");
  document.body.appendChild(box);
  let current = null;

  const show = (btn) => {
    current = btn;
    box.textContent = btn.dataset.tip;
    box.classList.add("show");
    const r = btn.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    // Below the button, or above it when there is no room below.
    const top = r.bottom + 8 + h < innerHeight ? r.bottom + 8 : r.top - h - 8;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(8, top)}px`;
  };
  const hide = () => {
    current = null;
    box.classList.remove("show");
  };

  document.addEventListener("mouseover", (e) => {
    const btn = e.target.closest?.(".tip");
    if (btn && btn !== current) show(btn);
    else if (!btn && current) hide();
  });
  document.addEventListener("focusin", (e) => (e.target.classList?.contains("tip") ? show(e.target) : hide()));
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("click", (e) => {
    // Touch screens have no hover: a tap toggles the explanation.
    const btn = e.target.closest?.(".tip");
    if (btn) {
      e.stopPropagation();
      btn === current ? hide() : show(btn);
    }
  }, true);
}
