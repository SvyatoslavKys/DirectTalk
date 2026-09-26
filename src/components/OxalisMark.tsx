import { useId } from "react";

export type OxalisState = "offline" | "connecting" | "online";

export function OxalisMark({
  state,
  className = "",
}: {
  state: OxalisState;
  className?: string;
}) {
  const id = useId().replaceAll(":", "");
  const topGradient = `${id}-oxalis-top`;
  const leftGradient = `${id}-oxalis-left`;
  const rightGradient = `${id}-oxalis-right`;

  return (
    <span
      className={`flower-mark oxalis-mark ${className}`.trim()}
      data-state={state}
      aria-hidden="true"
    >
      <svg className="oxalis-mark__svg" viewBox="0 0 72 72" focusable="false">
        <defs>
          <linearGradient id={topGradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--oxalis-top-light)" />
            <stop offset="0.52" stopColor="var(--oxalis-top-mid)" />
            <stop offset="1" stopColor="var(--oxalis-top-dark)" />
          </linearGradient>
          <linearGradient id={leftGradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--oxalis-left-light)" />
            <stop offset="0.55" stopColor="var(--oxalis-left-mid)" />
            <stop offset="1" stopColor="var(--oxalis-left-dark)" />
          </linearGradient>
          <linearGradient id={rightGradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--oxalis-right-light)" />
            <stop offset="0.55" stopColor="var(--oxalis-right-mid)" />
            <stop offset="1" stopColor="var(--oxalis-right-dark)" />
          </linearGradient>
        </defs>

        <path className="oxalis-mark__stem-shadow" d="M37.5 66C34.5 55 34.8 47 36 39" />
        <path className="oxalis-mark__stem" d="M36 66C33.8 55 34.4 47 36 39" />

        <g className="oxalis-mark__leaf oxalis-mark__leaf--top">
          <g className="oxalis-mark__leaf-shape">
            <path
              className="oxalis-mark__leaf-fill"
              fill={`url(#${topGradient})`}
              d="M36 38L11.5 15.7C17.8 9.2 25.2 7.1 31.8 9.8C33.9 10.7 35.2 12 36 13.4C36.8 12 38.1 10.7 40.2 9.8C46.8 7.1 54.2 9.2 60.5 15.7Z"
            />
            <path className="oxalis-mark__vein" d="M36 37.5C35.7 29.3 35.8 20.6 36 13.8" />
            <path className="oxalis-mark__shine" d="M18.4 15.8C23.9 11.8 29.1 11.5 32.5 13" />
          </g>
        </g>

        <g className="oxalis-mark__leaf oxalis-mark__leaf--left">
          <g className="oxalis-mark__leaf-shape">
            <path
              className="oxalis-mark__leaf-fill"
              fill={`url(#${leftGradient})`}
              d="M36 38L11.5 15.7C17.8 9.2 25.2 7.1 31.8 9.8C33.9 10.7 35.2 12 36 13.4C36.8 12 38.1 10.7 40.2 9.8C46.8 7.1 54.2 9.2 60.5 15.7Z"
            />
            <path className="oxalis-mark__vein" d="M36 37.5C35.7 29.3 35.8 20.6 36 13.8" />
            <path className="oxalis-mark__shine" d="M18.4 15.8C23.9 11.8 29.1 11.5 32.5 13" />
          </g>
        </g>

        <g className="oxalis-mark__leaf oxalis-mark__leaf--right">
          <g className="oxalis-mark__leaf-shape">
            <path
              className="oxalis-mark__leaf-fill"
              fill={`url(#${rightGradient})`}
              d="M36 38L11.5 15.7C17.8 9.2 25.2 7.1 31.8 9.8C33.9 10.7 35.2 12 36 13.4C36.8 12 38.1 10.7 40.2 9.8C46.8 7.1 54.2 9.2 60.5 15.7Z"
            />
            <path className="oxalis-mark__vein" d="M36 37.5C35.7 29.3 35.8 20.6 36 13.8" />
            <path className="oxalis-mark__shine" d="M18.4 15.8C23.9 11.8 29.1 11.5 32.5 13" />
          </g>
        </g>

        <circle className="oxalis-mark__node-ring" cx="36" cy="39" r="5.1" />
        <circle className="oxalis-mark__node" cx="36" cy="39" r="3.25" />
        <circle className="oxalis-mark__node-shine" cx="34.8" cy="37.8" r="0.9" />
      </svg>
    </span>
  );
}
