// Divisor arrastrable entre el panel del IDE (izquierda) y el emulador (derecha).
// El ancho del IDE se guarda en localStorage.
const KEY = "ideWidth";
const MIN = 240;

export function mountSplitter(app: HTMLElement, ide: HTMLElement, splitter: HTMLElement): void {
  const apply = (w: number): void => {
    const max = Math.max(MIN, window.innerWidth - 360);
    app.style.setProperty("--ide-w", `${Math.min(max, Math.max(MIN, w))}px`);
  };
  const saved = Number(localStorage.getItem(KEY));
  apply(saved > 0 ? saved : Math.round(window.innerWidth * 0.42));

  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("active");
    const x0 = e.clientX;
    const w0 = ide.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => apply(w0 + ev.clientX - x0);
    const up = (): void => {
      splitter.removeEventListener("pointermove", move);
      splitter.classList.remove("active");
      localStorage.setItem(KEY, String(Math.round(ide.getBoundingClientRect().width)));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });
  splitter.addEventListener("dblclick", () => {
    localStorage.removeItem(KEY);
    apply(Math.round(window.innerWidth * 0.42));
  });
}
