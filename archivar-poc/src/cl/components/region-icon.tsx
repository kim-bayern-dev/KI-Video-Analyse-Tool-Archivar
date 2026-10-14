import { createRef, type Props, type Ref } from "defuss";
import { Icon, type IconProps } from "./icon";

export type RegionType = "noise" | "ambience" | "harmonic" | "speech" | "silence" | "scene" | "sceneKeyframe";

export interface RegionIconProps extends Omit<IconProps, 'icon'> {
  regionType: RegionType;
  ref?: Ref;
}

/**
 * Maps region types to appropriate uk-icon names
 */
const getRegionIcon = (regionType: RegionType): string => {
  switch (regionType) {
    case "speech":
      return "mic"; // Microphone icon for speech
    case "silence":
      return "volume-x"; // Muted volume icon for silence
    case "noise":
      return "volume-2"; // High volume icon for noise
    case "ambience":
      return "music"; // Music note icon for ambience
    case "harmonic":
      return "activity"; // Activity/waveform icon for harmonic content
    case "scene":
      return "film"; // Film icon for scene changes
    case "sceneKeyframe":
      return "image"; // Image icon for scene keyframes
    default:
      return "help-circle"; // Fallback icon
  }
};

/**
 * RegionIcon component that displays appropriate icons for different region types
 * 
 * Usage:
 * <RegionIcon regionType="speech" height={16} />
 * <RegionIcon regionType="silence" className="text-gray-500" />
 */
export const RegionIcon = ({
  regionType,
  className = "",
  height = 16,
  width = 16,
  strokeWidth = 2,
  ref = createRef(),
  ...props
}: RegionIconProps) => {
  const iconName = getRegionIcon(regionType);
  
  return (
    <Icon
      ref={ref}
      icon={iconName}
      className={className}
      height={height}
      width={width}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
};
