import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * BYOK P3：二维码展示组件。`qrcode` 依赖此前已在 packages/ui 但无使用点，这里补上封装。
 * 内容由调用方给出（如 `https://host/#token=...`），组件只负责渲染，不参与 token 生命周期。
 */
export function QrCode({
  value,
  size = 180,
  className,
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 1, width: size })
      .then((url: string) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDataUrl(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [size, value]);

  if (failed) {
    return null;
  }
  if (!dataUrl) {
    return <div className={className} style={{ height: size, width: size }} aria-hidden="true" />;
  }
  // toDataURL 生成内联 data: URI，token 不经过网络与磁盘缓存。
  return <img src={dataUrl} width={size} height={size} alt="QR code" className={className} />;
}
