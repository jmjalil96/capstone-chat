import { useEffect, useState } from "react";

import { MOBILE_SHELL_MEDIA_QUERY } from "./config";

export function useMobileShell(): boolean {
  const [mobile, setMobile] = useState(
    () => globalThis.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY).matches ?? false,
  );

  useEffect(() => {
    const media = globalThis.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY);
    if (!media) {
      return;
    }
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}
