type IconName =
  | "activity"
  | "arrow-down"
  | "arrow-right"
  | "arrow-up"
  | "arrow-up-right"
  | "arrow-clockwise"
  | "arrow-repeat"
  | "box-arrow-up-right"
  | "check"
  | "check-all"
  | "chevron-down"
  | "copy"
  | "download"
  | "exclamation-circle"
  | "github"
  | "gitlab"
  | "git"
  | "inbox"
  | "layers"
  | "list"
  | "moon"
  | "plus"
  | "search"
  | "signpost-split"
  | "star"
  | "sun"
  | "tag"
  | "trash"
  | "x"
  | "x-circle";

export default function Icon({
  name,
  size,
  className = "",
}: {
  name: IconName;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`app-icon bi bi-${name} ${className}`}
      style={{ fontSize: size, width: size, height: size }}
    />
  );
}