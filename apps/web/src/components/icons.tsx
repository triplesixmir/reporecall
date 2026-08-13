import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'arrow'
  | 'book'
  | 'check'
  | 'chevron'
  | 'close'
  | 'commit'
  | 'diamond'
  | 'file'
  | 'folder'
  | 'graph'
  | 'inbox'
  | 'menu'
  | 'plus'
  | 'search'
  | 'settings'
  | 'spark'
  | 'stack'
  | 'trash'
  | 'warning';

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...props,
  };

  const paths: Record<IconName, ReactElement> = {
    arrow: <path d="M5 12h13m-5-5 5 5-5 5" />,
    book: <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5m0-17v17m0-17H20" />,
    check: <path d="m5 12 4.3 4.3L19 6.7" />,
    chevron: <path d="m7 9 5 5 5-5" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    commit: <path d="M6 4v16m0-12h8a3 3 0 0 1 0 6H6m10-3h2" />,
    diamond: <path d="m12 3 8 9-8 9-8-9 8-9Z" />,
    file: <path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 13h6m-6 4h4" />,
    folder: <path d="M3 6.5h7l2 2h9v10H3v-12Zm0 2h18" />,
    graph: <path d="M5 18 10 12l4 3 5-8M5 18h15" />,
    inbox: <path d="M4 5h16v14H4V5Zm0 8h4l2 3h4l2-3h4M8 9h.01M12 9h.01M16 9h.01" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <path d="m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />,
    settings: (
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2m9-8.5h-2M5 12H3m15.4-6.4-1.4 1.4M7 17l-1.4 1.4m12.8 0L17 17M7 7 5.6 5.6" />
    ),
    spark: (
      <path d="m12 3 1.2 5.8L19 10l-5.8 1.2L12 17l-1.2-5.8L5 10l5.8-1.2L12 3ZM19 16l.5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" />
    ),
    stack: <path d="m12 3 8 4-8 4-8-4 8-4Zm-8 9 8 4 8-4M4 17l8 4 8-4" />,
    trash: <path d="M5 7h14m-9-3h4l1 3H9l1-3Zm-4 3 1 13h8l1-13M10 11v8m4-8v8" />,
    warning: <path d="m12 4 9 16H3L12 4Zm0 5v5m0 3h.01" />,
  };

  return <svg {...common}>{paths[name]}</svg>;
}
