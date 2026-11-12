import ErrorBoundary from "@/components/ErrorBoundary";
import ExplorerShell from "@/components/ExplorerShell";

export default function Home() {
  return (
    <ErrorBoundary>
      <ExplorerShell />
    </ErrorBoundary>
  );
}
