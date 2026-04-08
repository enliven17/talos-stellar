"use client";

import { useEffect, useRef } from "react";

export function HeroClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const chars = ".:-=+*#%@";
    const fontSize = 14;

    let W = 0;
    let H = 0;
    let cols = 0;
    let rows = 0;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      canvas!.width = W * dpr;
      canvas!.height = H * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.floor(W / (fontSize * 0.6));
      rows = Math.floor(H / fontSize);
    }

    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    let animId: number;

    function draw() {
      ctx!.fillStyle = "#FCF8F8";
      ctx!.fillRect(0, 0, W, H);
      ctx!.font = `${fontSize}px monospace`;

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cx = x / cols - 0.5;
          const cy = y / rows - 0.5;
          const dist = Math.sqrt(cx * cx + cy * cy);
          const wave = Math.sin(dist * 12 - frame * 0.03) * 0.5 + 0.5;
          const noise =
            Math.sin(x * 0.3 + frame * 0.01) *
            Math.cos(y * 0.3 + frame * 0.02);
          const val = wave * 0.7 + noise * 0.3;
          const idx = Math.floor(
            Math.max(0, Math.min(1, val)) * (chars.length - 1)
          );

          const alpha = 0.2 + val * 0.4;
          // Blend pink accent into regions near wave peaks
          const pinkMix = Math.max(0, wave - 0.6) * 2.5; // 0..1 at wave peaks
          const r = Math.round(142 * (1 - pinkMix) + 245 * pinkMix);
          const g = Math.round(131 * (1 - pinkMix) + 175 * pinkMix);
          const b = Math.round(131 * (1 - pinkMix) + 175 * pinkMix);
          ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx!.fillText(chars[idx], x * fontSize * 0.6, y * fontSize + fontSize);
        }
      }
      frame++;
      animId = requestAnimationFrame(draw);
    }

    draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full opacity-60"
    />
  );
}
