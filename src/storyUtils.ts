import type { Race } from "./db";

const STORY_WIDTH = 1080;
const STORY_HEIGHT = 1920;

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The selected race photo could not be loaded."));
    image.src = source;
  });
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  font: string,
  maxWidth: number,
  minSize: number
) {
  const match = font.match(/(\d+)px/);
  const originalSize = match ? Number(match[1]) : 32;
  let size = originalSize;
  const fontWithSize = (value: number) => font.replace(/\d+px/, `${value}px`);

  context.font = fontWithSize(size);
  while (context.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    context.font = fontWithSize(size);
  }

  if (context.measureText(text).width > maxWidth) {
    let shortened = text;
    while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
      shortened = shortened.slice(0, -1);
    }
    return `${shortened}…`;
  }
  return text;
}

async function generateIGStory(race: Race): Promise<Blob> {
  const photo = race.finisherPhoto || race.medalImage || race.bibImage;
  if (!photo) throw new Error("Add a race photo before creating a story.");

  const image = await loadImage(photo);
  await document.fonts?.ready;

  const canvas = document.createElement("canvas");
  canvas.width = STORY_WIDTH;
  canvas.height = STORY_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not create the story image.");

  context.fillStyle = "#090C15";
  context.fillRect(0, 0, STORY_WIDTH, STORY_HEIGHT);

  const scale = Math.max(STORY_WIDTH / image.naturalWidth, STORY_HEIGHT / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (STORY_WIDTH - width) / 2, (STORY_HEIGHT - height) / 2, width, height);

  const gradient = context.createLinearGradient(0, STORY_HEIGHT * 0.4, 0, STORY_HEIGHT);
  gradient.addColorStop(0, "rgba(9, 12, 21, 0)");
  gradient.addColorStop(1, "rgba(9, 12, 21, 0.96)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, STORY_WIDTH, STORY_HEIGHT);
  context.textAlign = "center";
  context.textBaseline = "middle";

  if (race.chipTime) {
    context.fillStyle = "#C7F36B";
    const time = fitText(context, race.chipTime, "800 160px Manrope, sans-serif", STORY_WIDTH - 100, 84);
    context.fillText(time, STORY_WIDTH / 2, STORY_HEIGHT - 440);
  }

  context.fillStyle = "#ffffff";
  const raceDetails = `${race.name.toUpperCase()} · ${race.distance.toUpperCase()}`;
  const details = fitText(context, raceDetails, "800 45px Manrope, sans-serif", STORY_WIDTH - 100, 26);
  context.fillText(details, STORY_WIDTH / 2, STORY_HEIGHT - 320);

  const telemetry = [
    race.avgHr && `${race.avgHr} BPM`,
    race.avgPace && `${race.avgPace}/KM`,
    race.watch && `TRACKED WITH ${race.watch.toUpperCase()}`
  ].filter(Boolean).join("  |  ");
  if (telemetry) {
    context.fillStyle = "#CBD5E1";
    const telemetryLine = fitText(context, telemetry, "600 32px 'DM Mono', monospace", STORY_WIDTH - 100, 20);
    context.fillText(telemetryLine, STORY_WIDTH / 2, STORY_HEIGHT - 230);
  }

  if (race.shoes) {
    context.fillStyle = "#CBD5E1";
    const shoeLine = fitText(context, `RAN IN ${race.shoes.toUpperCase()}`, "600 28px 'DM Mono', monospace", STORY_WIDTH - 100, 18);
    context.fillText(shoeLine, STORY_WIDTH / 2, STORY_HEIGHT - 155);
  }

  context.fillStyle = "#C7F36B";
  context.font = "800 28px 'DM Mono', monospace";
  context.fillText("OUT OF OFFICE PACE", STORY_WIDTH / 2, STORY_HEIGHT - 82);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("The story image could not be exported."));
    }, "image/jpeg", 0.95);
  });
}

export async function shareToIG(race: Race): Promise<void> {
  try {
    const blob = await generateIGStory(race);
    const file = new File([blob], `ooo-pace-${race.id ?? Date.now()}.jpg`, { type: "image/jpeg" });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: `${race.name} Finisher`,
        text: `Finished the ${race.distance} at ${race.name}!`
      });
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ooo-pace-story-${race.id ?? Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = error instanceof Error ? error.message : "The story image could not be created.";
    alert(message);
    console.error("Instagram story generation failed:", error);
  }
}
