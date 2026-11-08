"use client";

import { useEffect, useState } from "react";

const TITLE = "LUMINO AGENT";

export default function Intro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t1 = window.setTimeout(() => setLeaving(true), 3600);
    const t2 = window.setTimeout(onDone, 4300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [onDone]);

  const skip = () => {
    setLeaving(true);
    window.setTimeout(onDone, 350);
  };

  return (
    <div className={`intro ${leaving ? "out" : ""}`} onClick={skip}>
      <div className="intro-ring" style={{ width: 460, height: 460 }} />
      <div
        className="intro-ring"
        style={{ width: 460, height: 460, animationDelay: "1.1s" }}
      />

      <div className="intro-title" aria-label={TITLE}>
        {TITLE.split("").map((ch, i) => (
          <span
            key={i}
            style={{ animationDelay: `${0.35 + i * 0.075}s` }}
            aria-hidden
          >
            {ch === " " ? "\u00A0" : ch}
          </span>
        ))}
      </div>

      <div className="intro-sub">Intelligence · Voice · Vision · Motion</div>

      <div className="intro-bar">
        <i />
      </div>

      <button type="button" className="intro-skip" onClick={skip}>
        Click to skip
      </button>
    </div>
  );
}
