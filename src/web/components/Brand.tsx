import { HeartPulse } from "lucide-react";

export function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg">
        <HeartPulse className="size-4" />
      </div>
      <span className="text-lg font-semibold tracking-tight">KeepWatch</span>
    </div>
  );
}
