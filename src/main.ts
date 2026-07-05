import "./style.css";
import { Game } from "./game/game";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const loading = document.getElementById("loading");

// Wait for fonts (used across the ink UI) before first paint to avoid a flash
// of fallback glyphs, but never block for more than a moment.
async function boot() {
  try {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]);
    }
  } catch {
    /* fonts API unavailable */
  }

  const game = new Game(canvas);
  game.start();

  if (loading) {
    loading.classList.add("hidden");
    setTimeout(() => loading.remove(), 700);
  }
}

boot();
