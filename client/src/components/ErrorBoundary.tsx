import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback: ReactNode;
}

interface State {
  hasError: boolean;
}

// Catches render-time crashes (e.g. a WebGL context failure inside react-globe.gl's
// Three.js internals that isn't caught by our own WebGL feature check) so the whole
// app doesn't go blank — it falls back to a plain listener list instead.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("cliamp-radio caught a render error:", error, info);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
