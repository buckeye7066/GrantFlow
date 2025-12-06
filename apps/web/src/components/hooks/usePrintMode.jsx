import { useEffect, useState } from 'react';

export function usePrintMode() {
  const [isPrint, setIsPrint] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('print');
    const before = () => setIsPrint(true);
    const after  = () => setIsPrint(false);

    // Chrome/Edge support
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    
    // Fallback for Safari/Firefox
    const onChange = (e) => setIsPrint(e.matches);
    if (media.addEventListener) {
        media.addEventListener('change', onChange);
    } else {
        // Deprecated but required for some browsers
        media.addListener(onChange);
    }

    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      if (media.removeEventListener) {
          media.removeEventListener('change', onChange);
      } else {
          media.removeListener(onChange);
      }
    };
  }, []);
  return isPrint;
}