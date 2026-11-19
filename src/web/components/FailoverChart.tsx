import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { withTimePreferences } from "@/lib/format";

const dayLabel = (value: number) =>
  new Date(value).toLocaleDateString(
    undefined,
    withTimePreferences({ month: "short", day: "numeric", timeZone: "UTC" }),
  );

/** Failovers per day. */
export function FailoverChart({ data }: { data: { day: number; failovers: number }[] }) {
  if (!data.some((d) => d.failovers > 0)) {
    return <div className="text-muted-foreground grid h-56 place-items-center text-sm">No failovers in 30 days</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={224}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="day"
          tickFormatter={dayLabel}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          labelFormatter={(v) => dayLabel(Number(v))}
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="failovers" name="Failovers" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
