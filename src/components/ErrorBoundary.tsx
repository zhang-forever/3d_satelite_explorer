"use client";

import React, { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to external error reporting in production
    if (process.env.NODE_ENV === "development") {
      console.error("[ErrorBoundary]", error, errorInfo);
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="error-boundary-fallback"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
            background: "#050713",
            color: "#eef5ff",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            textAlign: "center",
            gap: "1rem"
          }}
        >
          <AlertTriangle
            size={48}
            style={{ color: "#fb7185", flexShrink: 0 }}
            aria-hidden="true"
          />
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              margin: 0,
              color: "#fde68a"
            }}
          >
            {this.props.fallbackTitle ?? "Something went wrong"}
          </h1>
          <p
            style={{
              maxWidth: 480,
              color: "#93a4b8",
              lineHeight: 1.5,
              margin: 0
            }}
          >
            {this.props.fallbackMessage ??
              "An unexpected error occurred while rendering the 3D satellite explorer. Please try refreshing the page."}
          </p>
          {this.state.error ? (
            <details
              style={{
                maxWidth: 600,
                width: "100%",
                marginTop: "0.5rem",
                textAlign: "left"
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  color: "#93a4b8",
                  fontSize: "0.8rem"
                }}
              >
                Technical details
              </summary>
              <pre
                style={{
                  marginTop: "0.5rem",
                  padding: "0.75rem",
                  borderRadius: 8,
                  background: "rgba(15, 23, 42, 0.9)",
                  border: "1px solid rgba(148, 163, 184, 0.22)",
                  color: "#fb7185",
                  fontSize: "0.75rem",
                  overflow: "auto",
                  maxHeight: 200
                }}
              >
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack}
              </pre>
            </details>
          ) : null}
          <button
            type="button"
            onClick={this.handleReset}
            aria-label="Try again after error"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "0.5rem 1.25rem",
              borderRadius: 8,
              border: "1px solid rgba(103, 232, 249, 0.4)",
              background: "rgba(8, 145, 178, 0.2)",
              color: "#67e8f9",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
              marginTop: "0.5rem"
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
