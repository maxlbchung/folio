import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const Icon = ({ size = 16, children, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const MinusIcon = (props: IconProps) => <Icon {...props}><path d="M5 12h14" /></Icon>;
export const GripIcon = (props: IconProps) => <Icon {...props}><circle cx="9" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1" fill="currentColor" stroke="none"/></Icon>;
export const TrashIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></Icon>;
export const SunIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></Icon>;
export const MoonIcon = (props: IconProps) => <Icon {...props}><path d="M20 15.2A8.5 8.5 0 1 1 8.8 4 7 7 0 0 0 20 15.2Z" /></Icon>;
export const ZoomInIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/></Icon>;
export const ZoomOutIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M7.5 10.5h6"/></Icon>;
export const FullscreenIcon = (props: IconProps) => <Icon {...props}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/></Icon>;
export const ExitFullscreenIcon = (props: IconProps) => <Icon {...props}><path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"/></Icon>;
export const AlignLeftIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h16M4 10h11M4 14h16M4 18h9"/></Icon>;
export const AlignCenterIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h16M7 10h10M4 14h16M8 18h8"/></Icon>;
export const AlignRightIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h16M9 10h11M4 14h16M11 18h9"/></Icon>;
export const AlignTopIcon = (props: IconProps) => <Icon {...props}><path d="M5 4h14M7 8v9M12 8v6M17 8v3"/></Icon>;
export const AlignMiddleIcon = (props: IconProps) => <Icon {...props}><path d="M4 12h16M7 7v10M12 8v8M17 9v6"/></Icon>;
export const AlignBottomIcon = (props: IconProps) => <Icon {...props}><path d="M5 20h14M7 7v9M12 10v6M17 13v3"/></Icon>;
export const RemoveFormatIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 16-16M8 5h10M13 5l-4 12M6 17h7"/></Icon>;
export const SaveIcon = (props: IconProps) => <Icon {...props}><path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-8h8v8" /></Icon>;
export const ExportIcon = (props: IconProps) => <Icon {...props}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></Icon>;
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M3 6h7l2 2h9v11H3z" /></Icon>;
export const FileIcon = (props: IconProps) => <Icon {...props}><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></Icon>;
export const HomeIcon = (props: IconProps) => <Icon {...props}><path d="m3 11 9-8 9 8M5 10v10h14V10M9 20v-6h6v6" /></Icon>;
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></Icon>;
export const EditIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.8 6.7l3.5 3.5" /></Icon>;
export const DuplicateIcon = (props: IconProps) => <Icon {...props}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>;
export const CutIcon = (props: IconProps) => <Icon {...props}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></Icon>;
export const CopyIcon = (props: IconProps) => <Icon {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><rect x="4" y="4" width="11" height="11" rx="2" /></Icon>;
export const PasteIcon = (props: IconProps) => <Icon {...props}><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3" /></Icon>;
export const SelectAllIcon = (props: IconProps) => <Icon {...props}><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /></Icon>;
export const ArrowUpIcon = (props: IconProps) => <Icon {...props}><path d="m7 10 5-5 5 5M12 5v14" /></Icon>;
export const ArrowDownIcon = (props: IconProps) => <Icon {...props}><path d="m7 14 5 5 5-5M12 19V5" /></Icon>;
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L3.8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.5v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L3.8 7l2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.1h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.4 7l-.1.1A1.7 1.7 0 0 0 19 9a1.7 1.7 0 0 0 1.6 1h.1v4h-.1a1.7 1.7 0 0 0-1.6 1Z"/></Icon>;
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
export const TextIcon = (props: IconProps) => <Icon {...props}><path d="M5 5h14M12 5v14M8 19h8" /></Icon>;
export const UndoIcon = (props: IconProps) => <Icon {...props}><path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6" /></Icon>;
export const RedoIcon = (props: IconProps) => <Icon {...props}><path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6" /></Icon>;
export const NoteIcon = (props: IconProps) => <Icon {...props}><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></Icon>;
export const ChevronLeft = (props: IconProps) => <Icon {...props}><path d="m15 18-6-6 6-6" /></Icon>;
export const ChevronRight = (props: IconProps) => <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
export const ChevronUp = (props: IconProps) => <Icon {...props}><path d="m18 15-6-6-6 6" /></Icon>;
export const ChevronDown = (props: IconProps) => <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
export const MoreIcon = (props: IconProps) => <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></Icon>;
export const PenIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.8 6.7l3.5 3.5" /></Icon>;
export const HighlighterIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 5-1 9.5-9.5-4-4L5 15zM12.5 7.5l4 4M3 21h10" /></Icon>;
export const EraserIcon = (props: IconProps) => <Icon {...props}><path d="m7 18-3-3 9-10 6 6-7 7zM9 9l6 6M7 18h12" /></Icon>;
export const FlipIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h11a5 5 0 0 1 5 5v1M8 3 4 7l4 4M20 17H9a5 5 0 0 1-5-5v-1M16 21l4-4-4-4" /></Icon>;
export const PinIcon = (props: IconProps) => <Icon {...props}><path d="M9 3h6l-1 6 3 3.5V14H7v-1.5L10 9zM12 14v7" /></Icon>;
export const UnpinIcon = (props: IconProps) => <Icon {...props}><path d="M9 3h6l-1 6 3 3.5V14H7v-1.5L10 9zM12 14v7M4 4l16 16" /></Icon>;
// Card-size icons: fewer, larger tiles as the size grows.
export const GridSmallIcon = (props: IconProps) => <Icon {...props}>{[4, 10, 16].flatMap((y) => [4, 10, 16].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" fill="currentColor" stroke="none" />))}</Icon>;
export const GridMediumIcon = (props: IconProps) => <Icon {...props}>{[5, 13].flatMap((y) => [5, 13].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" rx="1.2" fill="currentColor" stroke="none" />))}</Icon>;
export const GridLargeIcon = (props: IconProps) => <Icon {...props}><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" /></Icon>;
