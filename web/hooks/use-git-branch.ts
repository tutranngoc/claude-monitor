"use client";

import { useEffect, useState } from "react";

interface BranchInfo {
  branch: string | null;
  detached: string | null;
  // True while the first fetch is in flight; UI uses this to decide
  // between "no chip" and "loading…" rendering.
  loading: boolean;
}

const EMPTY: BranchInfo = { branch: null, detached: null, loading: false };

// useGitBranch resolves the git branch (or detached short SHA) for a
// working directory. Refetches when the path changes, when the tab
// regains focus (catches user `git checkout` outside the app), and on
// a slow 30s timer so long-running sessions still see flips.
//
// Returns EMPTY directly when cwd is null — state isn't touched in that
// case. This avoids a setState-in-effect for the "no path" branch and
// keeps the hook's render output deterministic from inputs.
export function useGitBranch(cwd: string | null | undefined): BranchInfo {
  const [info, setInfo] = useState<BranchInfo>({
    branch: null,
    detached: null,
    loading: true,
  });

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/fs/branch?path=${encodeURIComponent(cwd)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          if (!cancelled) {
            setInfo({ branch: null, detached: null, loading: false });
          }
          return;
        }
        const data = (await res.json()) as {
          branch?: string | null;
          detached?: string | null;
        };
        if (!cancelled) {
          setInfo({
            branch: data.branch ?? null,
            detached: data.detached ?? null,
            loading: false,
          });
        }
      } catch {
        // Aborted, fetch error, or non-JSON. Treat as "no branch" rather
        // than surfacing an error chip — the UI just hides itself.
        if (!cancelled) {
          setInfo({ branch: null, detached: null, loading: false });
        }
      }
    };

    void fetchOnce();
    const onFocus = () => void fetchOnce();
    window.addEventListener("focus", onFocus);
    const id = setInterval(() => void fetchOnce(), 30_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      window.removeEventListener("focus", onFocus);
      clearInterval(id);
    };
  }, [cwd]);

  // No path → no branch. Returning the constant avoids any leftover
  // state from a previous cwd leaking through.
  if (!cwd) return EMPTY;
  return info;
}
