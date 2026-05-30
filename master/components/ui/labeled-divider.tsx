import * as React from "react";
import { cn } from "@/lib/utils";

// Horizontal divider with centered text (MUI Divider-with-children equivalent).
export function LabeledDivider({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 my-2", className)}>
      <div className="flex-1 h-px bg-border" />
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
        {children}
      </div>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}
