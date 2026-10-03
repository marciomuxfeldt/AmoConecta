import { useEffect, useRef, type ReactNode } from "react";

export function ScrollConfirmation({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reveal = () => {
      const panel = panelRef.current;
      if (!panel || typeof panel.scrollIntoView !== "function") return;
      panel.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    };
    if (typeof window.requestAnimationFrame === "function") {
      const frame = window.requestAnimationFrame(reveal);
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(reveal, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div ref={panelRef} id={id} className={className} data-confirmation-anchor>
      {children}
    </div>
  );
}