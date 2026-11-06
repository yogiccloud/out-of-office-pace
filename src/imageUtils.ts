/**
 * Resizes an image to a high-resolution width and compresses it as a JPEG Base64 string.
 */
export async function compressImage(file: File, maxWidth = 2500): Promise<string> {
  let fileToProcess = file;
  const isHeic = /\.(heic|heif)$/i.test(file.name)
    || /^image\/hei[cf](?:-sequence)?$/i.test(file.type);

  if (isHeic) {
    const { heicTo } = await import("heic-to");
    const convertedBlob = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: 0.92,
    });

    fileToProcess = new File(
      [convertedBlob],
      file.name.replace(/\.(heic|heif)$/i, ".jpg"),
      { type: "image/jpeg" },
    );
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(fileToProcess);
    
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      
      img.onload = () => {
        const canvas = document.createElement("canvas");
        // Calculate new dimensions keeping aspect ratio
        let newWidth = img.width;
        let newHeight = img.height;
        
        if (newWidth > maxWidth) {
          newHeight = Math.floor(img.height * (maxWidth / img.width));
          newWidth = maxWidth;
        }

        canvas.width = newWidth;
        canvas.height = newHeight;
        
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }
        
        ctx.drawImage(img, 0, 0, newWidth, newHeight);
        
        const compressedBase64 = canvas.toDataURL("image/jpeg", 0.92);
        resolve(compressedBase64);
      };
      
      img.onerror = (error) => reject(error);
    };
    
    reader.onerror = (error) => reject(error);
  });
}