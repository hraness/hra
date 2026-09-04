import { Component, type ReactNode } from "react";

export type ErrorBoundaryProps = Readonly<{
  children: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: unknown) => void;
}>;

type ErrorBoundaryState = Readonly<{ error: Error | null }>;

/**
 * `useQuery` from the Convex React client surfaces a failed subscription by
 * throwing during render. An authority failure must therefore be caught here
 * and handed to custody, which wipes the account key, rather than being allowed
 * to unmount the tree with the key still in memory.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return this.props.fallback(error, () => { this.setState({ error: null }); });
  }
}
