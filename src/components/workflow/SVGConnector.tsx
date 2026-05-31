"use client";

interface SVGConnectorProps {
  /** Index of this connector (between phases i and i+1) */
  index: number;
  /** Total number of phases */
  totalPhases: number;
  /** Status: pending, active, done */
  status: "pending" | "active" | "done";
  isCelebrating: boolean;
}

/**
 * Renders an SVG bezier curve connector between adjacent phase boxes.
 * Positioned within the SVG overlay layer of the pipeline scroll container.
 * Uses CSS classes for state-driven styling (color, glow, animation).
 */
export default function SVGConnector({
  index,
  totalPhases,
  status,
  isCelebrating,
}: SVGConnectorProps) {
  // Each phase box is 290px wide with 44px gap between them
  // Connector spans the 44px gap between phase[index] and phase[index+1]
  const phaseWidth = 290;
  const gap = 44;
  const startX = (index + 1) * phaseWidth + index * gap;
  const endX = startX + gap;
  const midY = 60; // Vertical center of the connector path

  // Bezier control points for a smooth horizontal curve
  const cp1x = startX + gap * 0.4;
  const cp2x = endX - gap * 0.4;

  const pathD = `M ${startX} ${midY} C ${cp1x} ${midY}, ${cp2x} ${midY}, ${endX} ${midY}`;

  const pathClassName = [
    "connector-path",
    status,
    isCelebrating ? "celebrate" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <path
      d={pathD}
      className={pathClassName}
      strokeLinecap="round"
    />
  );
}
