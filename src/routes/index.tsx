import { createFileRoute } from "@tanstack/react-router";
import { ExchangeApp } from "@/components/exchange/app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <ExchangeApp />;
}
