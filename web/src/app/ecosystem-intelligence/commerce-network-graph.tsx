"use client";

import { useEffect, useRef, useState } from "react";
import type { CommerceNetworkEdge } from "./commerce-network-table";

interface Point {
  id: string;
  name: string;
  x: number;
  y: number;
}

interface DragState {
  pointerX: number;
  pointerY: number;
  nodeId: string | null;
}

export function CommerceNetworkGraph({ edges }: { edges: CommerceNetworkEdge[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<Point[]>([]);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<DragState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredName, setHoveredName] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<CommerceNetworkEdge | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const nodes = new Map<string, string>();
    for (const edge of edges) {
      nodes.set(edge.buyer.id, edge.buyer.name);
      nodes.set(edge.seller.id, edge.seller.name);
    }
    const previousPoints = pointsRef.current;
    const points = previousPoints.length === nodes.size && previousPoints.every(point => nodes.has(point.id))
      ? previousPoints.map(point => ({ ...point, name: nodes.get(point.id) ?? point.name }))
      : [...nodes.entries()].map(([id, name], index) => {
          const angle = (index / Math.max(nodes.size, 1)) * Math.PI * 2 - Math.PI / 2;
          const radius = 0.38 + (index % 4) * 0.035;
          return { id, name, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        });
    pointsRef.current = points;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    };

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const { width, height } = bounds;
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).getPropertyValue("--surface").trim() || "#151918";
      context.fillRect(0, 0, width, height);
      const transform = transformRef.current;
      const centerX = width / 2 + transform.x;
      const centerY = height / 2 + transform.y;
      const radius = Math.min(width, height) * 0.42 * transform.scale;
      const positions = new Map(pointsRef.current.map(point => [point.id, {
        x: centerX + point.x * radius,
        y: centerY + point.y * radius,
      }]));

      for (const edge of edges) {
        const from = positions.get(edge.buyer.id);
        const to = positions.get(edge.seller.id);
        if (!from || !to) continue;
        const active = !selected || selected === edge.buyer.id || selected === edge.seller.id;
        context.lineWidth = Math.min(3, 1 + Math.sqrt(edge.jobCount) * 0.18);
        context.strokeStyle = active ? "rgba(72, 169, 153, 0.46)" : "rgba(120, 130, 130, 0.12)";
        context.beginPath();
        context.moveTo(from.x, from.y);
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const endX = to.x - Math.cos(angle) * 7;
        const endY = to.y - Math.sin(angle) * 7;
        context.lineTo(endX, endY);
        context.stroke();
        context.fillStyle = context.strokeStyle;
        context.beginPath();
        context.moveTo(endX, endY);
        context.lineTo(endX - Math.cos(angle - 0.45) * 7, endY - Math.sin(angle - 0.45) * 7);
        context.lineTo(endX - Math.cos(angle + 0.45) * 7, endY - Math.sin(angle + 0.45) * 7);
        context.closePath();
        context.fill();
      }

      for (const point of pointsRef.current) {
        const position = positions.get(point.id);
        if (!position) continue;
        const active = !selected || selected === point.id;
        context.fillStyle = active ? "#49aa98" : "#78817f";
        context.beginPath();
        context.arc(position.x, position.y, hovered === point.id || selected === point.id ? 7 : 5, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = active ? "#e5ecea" : "#8b9391";
        context.font = "12px sans-serif";
        context.textAlign = position.x < centerX ? "right" : "left";
        context.textBaseline = "middle";
        context.fillText(point.name.slice(0, 24), position.x + (position.x < centerX ? -10 : 10), position.y);
      }
    };

    const nodeAt = (clientX: number, clientY: number) => {
      const bounds = canvas.getBoundingClientRect();
      const transform = transformRef.current;
      const centerX = bounds.width / 2 + transform.x;
      const centerY = bounds.height / 2 + transform.y;
      const radius = Math.min(bounds.width, bounds.height) * 0.42 * transform.scale;
      return pointsRef.current.find(point => {
        const x = centerX + point.x * radius;
        const y = centerY + point.y * radius;
        return Math.hypot(clientX - bounds.left - x, clientY - bounds.top - y) < 14;
      }) ?? null;
    };
    const edgeAt = (clientX: number, clientY: number) => {
      const bounds = canvas.getBoundingClientRect();
      const transform = transformRef.current;
      const centerX = bounds.width / 2 + transform.x;
      const centerY = bounds.height / 2 + transform.y;
      const radius = Math.min(bounds.width, bounds.height) * 0.42 * transform.scale;
      const pointerX = clientX - bounds.left;
      const pointerY = clientY - bounds.top;
      return edges.find(edge => {
        const from = pointsRef.current.find(point => point.id === edge.buyer.id);
        const to = pointsRef.current.find(point => point.id === edge.seller.id);
        if (!from || !to) return false;
        const x1 = centerX + from.x * radius;
        const y1 = centerY + from.y * radius;
        const x2 = centerX + to.x * radius;
        const y2 = centerY + to.y * radius;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const ratio = Math.max(0, Math.min(1, ((pointerX - x1) * dx + (pointerY - y1) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(pointerX - (x1 + ratio * dx), pointerY - (y1 + ratio * dy)) < 6;
      }) ?? null;
    };

    const onPointerDown = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const point = nodeAt(event.clientX, event.clientY);
      dragRef.current = {
        pointerX: event.clientX - bounds.left,
        pointerY: event.clientY - bounds.top,
        nodeId: point?.id ?? null,
      };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const drag = dragRef.current;
      if (drag) {
        const dx = x - drag.pointerX;
        const dy = y - drag.pointerY;
        if (drag.nodeId) {
          const transform = transformRef.current;
          const radius = Math.min(bounds.width, bounds.height) * 0.42 * transform.scale;
          const point = pointsRef.current.find(item => item.id === drag.nodeId);
          if (point) {
            point.x += dx / radius;
            point.y += dy / radius;
          }
        } else {
          transformRef.current.x += dx;
          transformRef.current.y += dy;
        }
        drag.pointerX = x;
        drag.pointerY = y;
        draw();
      } else {
        const point = nodeAt(event.clientX, event.clientY);
        setHovered(point?.id ?? null);
        setHoveredName(point?.name ?? null);
        setHoveredEdge(point ? null : edgeAt(event.clientX, event.clientY));
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current?.nodeId) setSelected(dragRef.current.nodeId);
      dragRef.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      transformRef.current.scale = Math.min(2.5, Math.max(0.6, transformRef.current.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
      draw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    resize();

    return () => {
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [edges, hovered, selected]);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="h-[28rem] w-full touch-none"
        aria-label={`Commerce network graph with ${edges.length} buyer-to-seller relationships`}
      />
      {hovered && (
        <div className="absolute bottom-3 left-3 border border-border bg-surface px-3 py-2 text-xs text-foreground">
          {hoveredName}
        </div>
      )}
      {hoveredEdge && !hovered && (
        <div className="absolute bottom-3 left-3 border border-border bg-surface px-3 py-2 text-xs text-foreground">
          {hoveredEdge.buyer.name} to {hoveredEdge.seller.name} · {hoveredEdge.jobCount} jobs · {hoveredEdge.volume.toFixed(2)} volume
        </div>
      )}
      {selected && (
        <button
          type="button"
          className="absolute right-3 top-3 border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:text-foreground"
          onClick={() => setSelected(null)}
        >
          Clear selection
        </button>
      )}
    </div>
  );
}