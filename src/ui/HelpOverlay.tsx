import { useEffect, useState } from "react";
import { subscribeHelp, type HelpInfo } from "./help";

/**
 * Renders the "what is this?" tooltip while inspection mode (Shift held) is
 * active. Positioned at the anchor given by the help module: above a GUI
 * element, beside the cursor on the canvas.
 */
export function HelpOverlay(): JSX.Element | null {
  const [info, setInfo] = useState<HelpInfo | null>(null);

  useEffect(() => subscribeHelp(setInfo), []);

  if (!info) return null;

  const isElement = info.anchor === "element";
  const style: React.CSSProperties = isElement
    ? { left: info.x, top: info.y, transform: "translate(-50%, calc(-100% - 10px))" }
    : { left: info.x + 14, top: info.y + 14 };

  return (
    <div className={`help-overlay${isElement ? "" : " help-overlay-cursor"}`} style={style} role="tooltip">
      <div className="help-overlay-title">❓ {info.title}</div>
      {info.body && <div className="help-overlay-body">{info.body}</div>}
    </div>
  );
}
