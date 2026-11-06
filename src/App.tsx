import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, ExternalLink, Flag, Footprints, Home, Medal, Plus, Search, Trash2, Trophy, Upload, X, Camera, Edit2, MapPin, ShoppingBag, Coffee, Settings, Star, ShieldCheck, Lock, Share, Sparkles, Send } from "lucide-react";
import { format, parse, parseISO, isBefore, differenceInDays, isValid } from "date-fns";
import { db, type ChecklistItem, type Race, type Medal as MedalType } from "./db";
import { compressImage } from "./imageUtils";
import { shareToIG } from "./storyUtils";

type Tab = "overview" | "races" | "medals" | "gear";
type Filter = "all" | "upcoming" | "past";
type ImportAction = "import" | "update" | "skip";
type ImportCandidate = {
  id: string;
  race: Omit<Race, "id">;
  updateFields: Partial<Omit<Race, "id">>;
  existingId?: number;
  existingIds: number[];
  action: ImportAction;
  bookingIdEdited: boolean;
};
type ImportReview = { candidates: ImportCandidate[]; invalidRows: number; mergedDuplicates: number };
const today = new Date().toISOString().slice(0, 10);
const fmtDate = (value: string) => { 
  if (value.startsWith("2099")) return "TBA";
  try { return format(parseISO(value), "dd MMM yyyy"); } catch { return value; } 
};
const dateKey = (d: string) => d;
const currentYear = String(new Date().getFullYear());
const isWrappedSeason = new Date().getMonth() === 11;
const raceStringFields: Array<keyof Omit<Race, "id">> = [
  "name", "date", "endDate", "distance", "location", "organizer", "bookingPlatform",
  "bookingId", "bookingUrl", "bib", "chipTime", "supportCrew", "postRaceMeal",
  "weatherVibe", "shoes", "watch", "avgPace", "avgHr", "bibImage", "medalImage",
  "finisherPhoto",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getImportedStatus(value: unknown): Race["status"] | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLocaleLowerCase();
  if (status === "completed") return "completed";
  if (status === "registered" || status === "upcoming" || status === "paid") return "registered";
  if (status === "interested" || status === "not booked") return "interested";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return undefined;
}

function getImportedString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function getWindowFromNotes(notes?: string): { startDate: string; endDate: string } | undefined {
  if (!notes) return undefined;
  const match = notes.match(/(?:participation|event)\s+window:\s*(\d{1,2}\s+[a-z]+\s+\d{4})\s*[–—-]\s*(\d{1,2}\s+[a-z]+\s+\d{4})/i);
  if (!match) return undefined;
  const start = parse(match[1], "d MMMM yyyy", new Date());
  const end = parse(match[2], "d MMMM yyyy", new Date());
  if (!isValid(start) || !isValid(end) || end < start) return undefined;
  return { startDate: format(start, "yyyy-MM-dd"), endDate: format(end, "yyyy-MM-dd") };
}

function getRaceIdentity(race: Pick<Race, "name" | "date" | "endDate" | "notes">): string {
  const window = getWindowFromNotes(race.notes);
  const startDate = window && race.date === window.endDate ? window.startDate : race.date;
  const name = race.name.trim().toLocaleLowerCase()
    .replace(/\s*(?:-\s*virtual\s+event|\(virtual\))\s*$/i, "")
    .replace(/\s+/g, " ");
  return `${startDate}\u0000${name}`;
}

function mergeRaceDetails<T extends Partial<Omit<Race, "id">>>(
  existing: T,
  incoming: Partial<Omit<Race, "id">>,
): T & Partial<Omit<Race, "id">> {
  const merged = { ...existing, ...incoming };
  for (const field of raceStringFields) {
    const newValue = incoming[field];
    if (typeof newValue !== "string" || !newValue.trim()) {
      const oldValue = existing[field];
      if (typeof oldValue === "string") Object.assign(merged, { [field]: oldValue });
    }
  }

  const notes = [...new Set([existing.notes, incoming.notes]
    .flatMap(note => note?.split(/\r?\n/) ?? [])
    .map(note => note.trim())
    .filter(Boolean))];
  if (notes.length) merged.notes = notes.join("\n");

  if (existing.status === "completed" && incoming.status === "registered") {
    merged.status = "completed";
  }

  if (existing.checklist?.length || incoming.checklist?.length) {
    const checklist = new Map<string, ChecklistItem>();
    for (const item of [...(existing.checklist ?? []), ...(incoming.checklist ?? [])]) {
      const key = item.id || item.text.trim().toLocaleLowerCase();
      const previous = checklist.get(key);
      checklist.set(key, previous ? { ...previous, ...item, done: previous.done || item.done } : item);
    }
    merged.checklist = [...checklist.values()];
  }

  return merged;
}

function getRaceRecordScore(race: Race): number {
  const populatedFields = raceStringFields.reduce((score, field) =>
    score + (typeof race[field] === "string" && race[field].trim() ? 1 : 0), 0);
  return populatedFields
    + (race.bibImage ? 5 : 0)
    + (race.medalImage ? 5 : 0)
    + (race.finisherPhoto ? 5 : 0)
    + (race.checklist?.length ?? 0);
}

function formatRaceRange(date: string, endDate?: string): string {
  if (!endDate || endDate === date) return fmtDate(date);
  const start = parseISO(date);
  const end = parseISO(endDate);
  if (!isValid(start) || !isValid(end)) return `${fmtDate(date)} – ${fmtDate(endDate)}`;
  if (start.getFullYear() !== end.getFullYear()) {
    return `${format(start, "MMM dd, yyyy")} – ${format(end, "MMM dd, yyyy")}`;
  }
  if (start.getMonth() === end.getMonth()) {
    return `${format(start, "MMM dd")}–${format(end, "dd, yyyy")}`;
  }
  return `${format(start, "MMM dd")} – ${format(end, "MMM dd, yyyy")}`;
}

function isRacePast(race: Race): boolean {
  return race.status === "completed" || isBefore(parseISO(race.endDate ?? race.date), parseISO(today));
}

function normalizeImportedRace(raw: Record<string, unknown>): Omit<Race, "id"> | null {
  const name = getImportedString(raw, "name", "event_name") ?? "";
  const rawDate = getImportedString(raw, "date", "start_date")
    ?? (/unconfirmed|tba/i.test(String(raw.status ?? "")) ? "2099-12-31" : "");
  const notes = getImportedString(raw, "notes");
  const noteWindow = getWindowFromNotes(notes);
  const date = noteWindow && rawDate === noteWindow.endDate ? noteWindow.startDate : rawDate;
  const endDate = getImportedString(raw, "endDate", "end_date") ?? noteWindow?.endDate;
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValid(parseISO(date))) return null;
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !isValid(parseISO(endDate)) || endDate < date)) return null;

  const status = getImportedStatus(raw.status);
  const amountPaid = raw.amountPaid ?? raw.amount_paid;
  const checklist = raw.checklist;
  const race: Omit<Race, "id"> = {
    name,
    date,
    ...(endDate ? { endDate } : {}),
    distance: typeof raw.distance === "string" && raw.distance.trim() ? raw.distance.trim() : "Not specified",
    location: typeof raw.location === "string" ? raw.location.trim() : "",
    status: status ?? "registered",
    ...(getImportedString(raw, "organizer", "organiser") ? { organizer: getImportedString(raw, "organizer", "organiser") } : {}),
    ...(getImportedString(raw, "bookingPlatform", "booking_platform") ? { bookingPlatform: getImportedString(raw, "bookingPlatform", "booking_platform") } : {}),
    ...(getImportedString(raw, "bookingId", "booking_id", "registration_id") ? { bookingId: getImportedString(raw, "bookingId", "booking_id", "registration_id") } : {}),
    ...(typeof amountPaid === "number" && Number.isFinite(amountPaid) ? { amountPaid } : typeof amountPaid === "string" && amountPaid.trim() && Number.isFinite(Number(amountPaid)) ? { amountPaid: Number(amountPaid) } : {}),
    ...(getImportedString(raw, "bookingUrl", "booking_url") ? { bookingUrl: getImportedString(raw, "bookingUrl", "booking_url") } : {}),
    ...(getImportedString(raw, "bib", "bib_number") ? { bib: getImportedString(raw, "bib", "bib_number") } : {}),
    ...(notes ? { notes } : {}),
    ...(getImportedString(raw, "chipTime", "chip_time") ? { chipTime: getImportedString(raw, "chipTime", "chip_time") } : {}),
    ...(getImportedString(raw, "supportCrew", "support_crew") ? { supportCrew: getImportedString(raw, "supportCrew", "support_crew") } : {}),
    ...(getImportedString(raw, "postRaceMeal", "post_race_meal") ? { postRaceMeal: getImportedString(raw, "postRaceMeal", "post_race_meal") } : {}),
    ...(getImportedString(raw, "weatherVibe", "weather_vibe") ? { weatherVibe: getImportedString(raw, "weatherVibe", "weather_vibe") } : {}),
    ...(getImportedString(raw, "shoes") ? { shoes: getImportedString(raw, "shoes") } : {}),
    ...(getImportedString(raw, "watch") ? { watch: getImportedString(raw, "watch") } : {}),
    ...(getImportedString(raw, "avgPace", "avg_pace") ? { avgPace: getImportedString(raw, "avgPace", "avg_pace") } : {}),
    ...(getImportedString(raw, "avgHr", "avg_hr") ? { avgHr: getImportedString(raw, "avgHr", "avg_hr") } : {}),
    ...(getImportedString(raw, "bibImage", "bib_image") ? { bibImage: getImportedString(raw, "bibImage", "bib_image") } : {}),
    ...(getImportedString(raw, "medalImage", "medal_image") ? { medalImage: getImportedString(raw, "medalImage", "medal_image") } : {}),
    ...(getImportedString(raw, "finisherPhoto", "finisher_photo") ? { finisherPhoto: getImportedString(raw, "finisherPhoto", "finisher_photo") } : {}),
    ...(Array.isArray(checklist) && checklist.every(item =>
      isRecord(item) && typeof item.id === "string" && typeof item.text === "string" && typeof item.done === "boolean"
    ) ? { checklist: checklist as ChecklistItem[] } : {}),
  };
  return race;
}

function getImportUpdateFields(raw: Record<string, unknown>, race: Omit<Race, "id">): Partial<Omit<Race, "id">> {
  const fields: Partial<Omit<Race, "id">> = { name: race.name, date: race.date };
  if (race.endDate) fields.endDate = race.endDate;
  if (typeof raw.distance === "string" && raw.distance.trim()) fields.distance = race.distance;
  if (typeof raw.location === "string" && raw.location.trim()) fields.location = race.location;
  const status = getImportedStatus(raw.status);
  if (status) fields.status = status;
  const stringFields: Array<[keyof Omit<Race, "id">, string | undefined]> = [
    ["organizer", getImportedString(raw, "organizer", "organiser")],
    ["bookingPlatform", getImportedString(raw, "bookingPlatform", "booking_platform")],
    ["bookingId", getImportedString(raw, "bookingId", "booking_id", "registration_id")],
    ["bookingUrl", getImportedString(raw, "bookingUrl", "booking_url")],
    ["bib", getImportedString(raw, "bib", "bib_number")],
    ["notes", getImportedString(raw, "notes")],
    ["chipTime", getImportedString(raw, "chipTime", "chip_time")],
    ["supportCrew", getImportedString(raw, "supportCrew", "support_crew")],
    ["postRaceMeal", getImportedString(raw, "postRaceMeal", "post_race_meal")],
    ["weatherVibe", getImportedString(raw, "weatherVibe", "weather_vibe")],
    ["shoes", getImportedString(raw, "shoes")],
    ["watch", getImportedString(raw, "watch")],
    ["avgPace", getImportedString(raw, "avgPace", "avg_pace")],
    ["avgHr", getImportedString(raw, "avgHr", "avg_hr")],
    ["bibImage", getImportedString(raw, "bibImage", "bib_image")],
    ["medalImage", getImportedString(raw, "medalImage", "medal_image")],
    ["finisherPhoto", getImportedString(raw, "finisherPhoto", "finisher_photo")],
  ];
  for (const [field, value] of stringFields) {
    if (value) Object.assign(fields, { [field]: value });
  }

  const amountPaid = raw.amountPaid ?? raw.amount_paid;
  if (typeof amountPaid === "number" && Number.isFinite(amountPaid)) fields.amountPaid = amountPaid;
  else if (typeof amountPaid === "string" && amountPaid.trim() && Number.isFinite(Number(amountPaid))) fields.amountPaid = Number(amountPaid);

  if (Array.isArray(raw.checklist) && raw.checklist.every(item =>
    isRecord(item) && typeof item.id === "string" && typeof item.text === "string" && typeof item.done === "boolean"
  )) fields.checklist = raw.checklist as ChecklistItem[];
  return fields;
}

function distanceToKm(distance: string): number | undefined {
  const normalized = distance.toLowerCase().trim();
  if (/\b(hm|half[- ]?marathon)\b/.test(normalized)) return 21.1;
  if (/\b(full[- ]?marathon|marathon)\b/.test(normalized)) return 42.2;
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(?:k|km)\b/);
  return match ? Number(match[1]) : undefined;
}

function timeToSeconds(time?: string) {
  if (!time) return Number.POSITIVE_INFINITY;
  const parts = time.trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return Number.POSITIVE_INFINITY;
  if (parts.some(part => !/^\d+$/.test(part))) return Number.POSITIVE_INFINITY;

  const values = parts.map(Number);
  const seconds = parts.length === 3
    ? values[0] * 3600 + values[1] * 60 + values[2]
    : values[0] * 60 + values[1];
  const invalidClockField = parts.length === 3 && values[1] >= 60;
  if (invalidClockField || values[values.length - 1] >= 60 || seconds <= 0) return Number.POSITIVE_INFINITY;
  return seconds;
}

async function downloadPhoto(dataUrl: string) {
  let downloadBlob: Blob;
  try {
    const sourceBlob = await (await fetch(dataUrl)).blob();
    if (sourceBlob.type === "image/jpeg") {
      downloadBlob = sourceBlob;
    } else {
      const sourceUrl = URL.createObjectURL(sourceBlob);
      try {
        const image = new Image();
        image.src = sourceUrl;
        await image.decode();

        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Unable to prepare image for download.");
        context.drawImage(image, 0, 0);

        downloadBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error("Unable to convert image to JPEG."));
          }, "image/jpeg", 0.92);
        });
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    }

    const downloadUrl = URL.createObjectURL(downloadBlob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `ooo-pace-photo-${Date.now()}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } catch {
    alert("Unable to prepare this photo for download. Please try again.");
  }
}

async function syncMedalCabinet(races: Race[]) {
  const completedRaces = races.filter(race => race.status === "completed" && race.id !== undefined);

  await db.transaction("rw", db.medals, async () => {
    const linkedMedals = (await db.medals.toArray()).filter(medal => medal.raceId !== undefined);
    const retainedMedalIds = new Set<number>();

    for (const race of completedRaces) {
      const existing = linkedMedals.find(medal => medal.raceId === race.id);
      const medal: Omit<MedalType, "id"> = {
        raceId: race.id,
        name: race.name,
        date: race.date,
        event: [race.distance, race.location].filter(Boolean).join(" · ") || "Race achievement",
        imageData: race.medalImage,
      };

      if (existing?.id !== undefined) {
        await db.medals.update(existing.id, medal);
        retainedMedalIds.add(existing.id);
      } else {
        const id = await db.medals.add(medal);
        retainedMedalIds.add(id);
      }
    }

    for (const medal of linkedMedals) {
      if (medal.id !== undefined && !retainedMedalIds.has(medal.id)) {
        await db.medals.delete(medal.id);
      }
    }
  });
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [races, setRaces] = useState<Race[]>([]);
  const [medals, setMedals] = useState<MedalType[]>([]);
  const [modal, setModal] = useState<{ kind: "race" | "medal" | "import" | "settings", data?: any } | null>(null);
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [isPro, setIsPro] = useState(() => localStorage.getItem("ooo_pro") === "true");
  const [showOnboarding, setShowOnboarding] = useState(() => localStorage.getItem("ooo_onboarded") !== "true");
  const [showWrapped, setShowWrapped] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);

  async function refresh() {
    const r = await db.races.orderBy("date").toArray();
    await syncMedalCabinet(r);
    const m = await db.medals.orderBy("date").reverse().toArray();
    setRaces(r); setMedals(m); setReady(true);
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (!lightbox) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightbox]);

  const upcoming = races.filter(r => r.status === "registered" && !isRacePast(r));
  const completedRaces = races.filter(r => r.status === "completed");
  
  // Dashboard Analytics
  const nextRace = upcoming.sort((a, b) => a.date.localeCompare(b.date))[0];
  const daysToNext = (nextRace && !nextRace.date.startsWith("2099")) ? differenceInDays(parseISO(nextRace.date), parseISO(today)) : null;
  const virtualCount = races.filter(r => (r.distance + r.location + r.name).toLowerCase().includes("virtual")).length;
  const liveCount = races.length - virtualCount;
  
  const totalKm = useMemo(() => {
    return races.reduce((km, race) => km + (race.status === "completed" ? distanceToKm(race.distance) ?? 0 : 0), 0);
  }, [races]);

  const seasonKm = useMemo(() => {
    return races.reduce((km, race) => {
      if (race.status !== "completed" || !(race.endDate ?? race.date).startsWith(currentYear)) return km;
      return km + (distanceToKm(race.distance) ?? 0);
    }, 0);
  }, [races]);
  const ringCircumference = 2 * Math.PI * 54;
  const seasonProgress = Math.min(seasonKm / 100, 1);

  const personalBests = useMemo(() => {
    const bests: Partial<Record<"5K" | "10K" | "HALF MARATHON" | "MARATHON", Race>> = {};
    for (const race of races) {
      if (race.status !== "completed" || timeToSeconds(race.chipTime) === Number.POSITIVE_INFINITY) continue;

      const distance = (race.distance || "").toUpperCase();
      const category = distance.includes("5K") ? "5K"
        : distance.includes("10K") ? "10K"
        : distance.includes("HALF") || distance.includes("HM") ? "HALF MARATHON"
        : distance.includes("MARATHON") ? "MARATHON"
        : undefined;
      if (!category) continue;

      const current = bests[category];
      if (!current || timeToSeconds(race.chipTime) < timeToSeconds(current.chipTime)) bests[category] = race;
    }
    return bests;
  }, [races]);

  const shoeLocker = useMemo(() => {
    const shoes = new Map<string, {name: string; km: number; racesCount: number}>();
    for (const race of races) {
      if (race.status !== "completed" || !race.shoes?.trim()) continue;
      const km = distanceToKm(race.distance);
      if (km === undefined) continue;

      const name = race.shoes.trim();
      const key = name.toLocaleLowerCase();
      const current = shoes.get(key) ?? {name, km: 0, racesCount: 0};
      current.km += km;
      current.racesCount += 1;
      shoes.set(key, current);
    }
    return [...shoes.values()].sort((a, b) => b.km - a.km);
  }, [races]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = races.filter(r => {
      const isPast = isRacePast(r);
      const matchFilter = filter === "all" || (filter === "past" ? isPast : !isPast);
      const haystack = [r.name, r.location, r.organizer, r.bookingPlatform, r.bookingId, r.bib].join(" ").toLowerCase();
      return matchFilter && (!q || haystack.includes(q));
    });
    const groups = new Map<string, Race[]>();
    filtered.forEach(r => groups.set(dateKey(r.date), [...(groups.get(dateKey(r.date)) || []), r]));
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [races, filter, search]);

  async function removeRace(id?: number) { if (id && confirm("Delete this race and all its photos?")) { await db.races.delete(id); refresh(); } }
  async function removeMedal(id?: number) { if (id && confirm("Delete this medal?")) { await db.medals.delete(id); refresh(); } }

  async function toggleChecklistItem(raceId: number, itemId: string, done: boolean) {
    const race = await db.races.get(raceId);
    if (!race?.checklist) return;
    const checklist = race.checklist.map(item => item.id === itemId ? { ...item, done } : item);
    await db.races.update(raceId, { checklist });
    await refresh();
  }

  async function exportData() {
    const data = { exportedAt: new Date().toISOString(), races: await db.races.toArray(), medals: await db.medals.toArray() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const filename = `ooo-pace-backup-${today}.json`;
    const file = new File([blob], filename, { type: "application/json" });

    const downloadBackup = () => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "Out Of Office Pace Backup",
          text: "Race calendar and medal cabinet backup"
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        downloadBackup();
        return;
      }
    }

    downloadBackup();
  }

  async function importData(file?: File) {
    if (!file) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!isRecord(data) || !Array.isArray(data.races)) {
        throw new Error("The JSON file must contain a races array.");
      }

      const existingRaces = await db.races.toArray();
      const candidatesByKey = new Map<string, ImportCandidate>();
      let invalidRows = 0;
      let mergedDuplicates = 0;

      for (const [index, value] of data.races.entries()) {
        if (!isRecord(value)) {
          invalidRows++;
          continue;
        }
        const race = normalizeImportedRace(value);
        if (!race) {
          invalidRows++;
          continue;
        }
        const key = getRaceIdentity(race);
        const updateFields = getImportUpdateFields(value, race);
        const duplicate = candidatesByKey.get(key);
        if (duplicate) {
          duplicate.race = mergeRaceDetails(duplicate.race, race);
          duplicate.updateFields = mergeRaceDetails(duplicate.updateFields, updateFields);
          mergedDuplicates++;
          continue;
        }

        candidatesByKey.set(key, {
          id: `${index}-${race.date}-${race.name}`,
          race,
          updateFields,
          existingIds: [],
          action: "import",
          bookingIdEdited: false,
        });
      }

      const candidates = [...candidatesByKey.entries()].map(([key, candidate]) => {
        const matchingExisting = existingRaces
          .filter(item => getRaceIdentity(item) === key)
          .sort((a, b) => getRaceRecordScore(b) - getRaceRecordScore(a));
        candidate.existingIds = matchingExisting
          .map(item => item.id)
          .filter((id): id is number => id !== undefined);
        candidate.existingId = candidate.existingIds[0];
        candidate.action = candidate.existingId === undefined ? "import" : "skip";

        const details = matchingExisting.map(({ id: _id, ...race }) => race);
        const withExistingDetails = details.reduce(
          (merged, race) => mergeRaceDetails(merged, race),
          candidate.race,
        );
        candidate.race = mergeRaceDetails(withExistingDetails, candidate.race);
        return candidate;
      });
      if (candidates.length === 0) {
        alert(`No valid races were found in this file.${invalidRows ? ` ${invalidRows} invalid row(s) were skipped.` : ""}`);
        return;
      }

      setImportReview({ candidates, invalidRows, mergedDuplicates });
      setModal(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      alert(`Could not read the import file. ${message}`);
    }
  }

  async function confirmImport(candidates: ImportCandidate[]) {
    const selected = candidates.filter(candidate => candidate.action !== "skip");
    if (selected.length === 0) return;
    const imported = selected.filter(candidate => candidate.action === "import").length;
    const updated = selected.filter(candidate => candidate.action === "update").length;
    const consolidated = selected
      .filter(candidate => candidate.action === "update")
      .reduce((count, candidate) => count + Math.max(candidate.existingIds.length - 1, 0), 0);

    try {
      await db.transaction("rw", db.races, async () => {
        for (const candidate of selected) {
          if (candidate.action === "import") {
            await db.races.add(candidate.race);
            continue;
          }
          if (candidate.existingId === undefined) {
            throw new Error(`The existing race for "${candidate.race.name}" could not be identified.`);
          }
          const current = await db.races.get(candidate.existingId);
          if (!current) throw new Error(`The existing race for "${candidate.race.name}" no longer exists.`);
          const existingIds = candidate.existingIds.length ? candidate.existingIds : [candidate.existingId];
          const otherRecords = await Promise.all(existingIds
            .filter(id => id !== candidate.existingId)
            .map(id => db.races.get(id)));
          let merged: Partial<Omit<Race, "id">> = current;
          for (const record of otherRecords) {
            if (!record) continue;
            const { id: _id, ...details } = record;
            merged = mergeRaceDetails(merged, details);
          }
          merged = mergeRaceDetails(merged, candidate.updateFields);
          if (candidate.bookingIdEdited) merged.bookingId = candidate.race.bookingId ?? "";
          await db.races.update(candidate.existingId, merged);
          const duplicateIds = existingIds.filter(id => id !== candidate.existingId);
          if (duplicateIds.length) await db.races.bulkDelete(duplicateIds);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      alert(`Import was not completed. No changes were saved. ${message}`);
      return;
    }

    setImportReview(null);
    try {
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      alert(`Import saved, but the race list could not be refreshed. Reload the page to see the changes. ${message}`);
      return;
    }
    const skipped = candidates.filter(candidate => candidate.action === "skip").length + (importReview?.invalidRows ?? 0);
    alert(`Import complete: ${imported} added, ${updated} updated, ${consolidated} duplicate saved race(s) consolidated, ${skipped} skipped. ${importReview?.mergedDuplicates ?? 0} repeated backup row(s) merged.`);
  }

  function handleUpgrade(key: string) {
    if (key.trim().toUpperCase() !== "PACE-PRO-2026") {
      alert("Invalid demo key. Use PACE-PRO-2026 to preview Pro features.");
      return;
    }

    localStorage.setItem("ooo_pro", "true");
    setIsPro(true);
    setModal(null);
    alert("Demo Pro access enabled on this device. This is not a real purchase or license verification.");
  }

  function exportRaceCalendarPdf() {
    if (!isPro) {
      setModal({kind: "settings"});
      return;
    }
    window.print();
  }

  const affiliateGear = [
    { id: "nutrition", name: "Running gels", type: "Nutrition", description: "Fuel options for long training runs and race day.", url: "https://www.amazon.in/s?k=running+energy+gels" },
    { id: "shoes", name: "Road running shoes", type: "Footwear", description: "Compare daily trainers and race-day shoes.", url: "https://www.amazon.in/s?k=road+running+shoes" },
    { id: "watch", name: "GPS running watches", type: "Tech", description: "Browse watches with GPS and running metrics.", url: "https://www.amazon.in/s?k=GPS+running+watch" }
  ];

  const nav = [{ id: "overview" as Tab, label: "Overview", icon: Home }, { id: "races" as Tab, label: "Race calendar", icon: CalendarDays }, { id: "medals" as Tab, label: "Medals", icon: Medal }, { id: "gear" as Tab, label: "Gear Vault", icon: ShoppingBag }];
  
  if (showOnboarding) return <Onboarding close={() => setShowOnboarding(false)} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Footprints size={21}/></div><div><b>OUT OF OFFICE</b><span>PACE</span></div></div><div className="side-label">RACE MANAGEMENT</div><nav>{nav.map(n => <button key={n.id} className={tab === n.id ? "nav-item active" : "nav-item"} onClick={() => setTab(n.id)}><n.icon size={18}/>{n.label}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-tools"><button className="tool-btn" onClick={exportData} title="Export backup"><Download size={14}/> Backup</button><a href="https://www.buymeacoffee.com/" target="_blank" rel="noreferrer" className="tool-btn highlight" title="Placeholder support link; replace with your profile"><Coffee size={14}/> Support</a><button className="tool-btn" onClick={() => setModal({kind:"settings"})} title="Demo settings and Pro access"><Settings size={14}/> Settings</button></div><div className="status-indicator"><div className="sync-dot"/><span>Saved locally {isPro && <span className="pro-badge-small">DEMO PRO</span>}</span></div></div></aside>
    <main className="main"><header className="topbar"><div className="mobile-brand"><Footprints size={19}/> OOO PACE</div><div className="breadcrumb">PERSONAL RACE HUB <span>/</span> {tab.toUpperCase()}</div><div className="top-actions"><span className="local-pill"><i/> LOCAL MODE</span><button className="avatar" aria-label="Settings" onClick={() => setModal({kind:"settings"})}><Settings size={15}/></button></div></header>
      <div className="page">{!ready ? <div className="loading">Preparing your race calendar…</div> : <>
        {tab === "overview" && <div className="overview"><div className="hero"><div className="hero-copy"><div className="eyebrow"><span/> YOUR PERSONAL RACE HQ</div><h1>Every race.<br/><em>One calendar.</em></h1><p>Track registrations, finish-line photos, and personal memories — all in your offline vault.</p><button className="primary-button" onClick={() => setModal({kind:"race"})}><Plus size={17}/> ADD A RACE</button></div><div className="hero-graphic"><svg className="progress-ring" width="220" height="220" viewBox="0 0 120 120" role="img" aria-label={`${Math.floor(seasonKm)} of 100 annual race kilometres completed`}><circle cx="60" cy="60" r="54" fill="none" stroke="rgba(199, 243, 107, 0.1)" strokeWidth="3"/><circle cx="60" cy="60" r="54" fill="none" stroke="var(--lime)" strokeWidth="4" strokeDasharray={ringCircumference} strokeDashoffset={ringCircumference * (1 - seasonProgress)} strokeLinecap="round" transform="rotate(-90 60 60)"/></svg><div className="hero-number season-progress-value"><span>{Math.floor(seasonKm)}</span><span className="season-progress-label">RACE KMS</span></div><div className="hero-caption">SEASON<br/>PROGRESS</div></div><div className="hero-index">01 / PLAN YOUR SEASON</div></div>
          {(Object.keys(personalBests).length > 0 || isWrappedSeason) && <section className="pb-section"><div className="section-heading"><div><div className="eyebrow">YOUR FASTEST TIMES</div><h2>Hall of Fame</h2></div>{isWrappedSeason && <button type="button" className="secondary-button highlight-action wrapped-trigger" onClick={() => setShowWrapped(true)}><Sparkles size={14}/>{currentYear} WRAPPED</button>}</div>{Object.keys(personalBests).length > 0 ? <div className="pb-grid">
            {(["5K", "10K", "HALF MARATHON", "MARATHON"] as const).map(distance => {
              const best = personalBests[distance];
              return best ? <article className="pb-card" key={distance}><div className="pb-dist">{distance}</div><div className="pb-time">{best.chipTime}</div><div className="pb-race-name">{best.name}</div>{best.shoes && <div className="pb-gear"><Footprints size={12}/>{best.shoes}</div>}</article> : null;
            })}
          </div> : <div className="empty-state pb-empty"><p>Complete a race and add an official chip time to see your personal bests here.</p></div>}</section>}
          <div className="section-heading"><div><div className="eyebrow">THE BIG PICTURE</div><h2>Your race snapshot</h2></div><span className="muted">{format(new Date(), "EEEE, dd MMM yyyy")}</span></div>
          <div className="stats-grid">
            <Stat label="UPCOMING REGISTRATIONS" value={String(upcoming.length)} unit="RACES" icon={CalendarDays}/>
            <Stat label="COMPLETED RACES" value={String(completedRaces.length)} unit="RACES" icon={Flag}/>
            <Stat label="COMPLETED RACE DISTANCE" value={totalKm > 0 ? String(totalKm) : "--"} unit="KM" icon={MapPin}/>
            <Stat label="EVENT TYPES" value={String(liveCount)} unit={`LIVE / ${virtualCount} VIRTUAL`} icon={Trophy}/>
          </div>
          <div className="content-grid"><div className="panel"><div className="panel-heading"><div><div className="eyebrow">YOUR NEXT EVENTS</div><h3>Coming up</h3></div><button className="subtle-link" onClick={() => setTab("races")}>All races <ChevronRight size={15}/></button></div>
            {nextRace && daysToNext !== null && daysToNext >= 0 && <div className="countdown-bar"><b>{daysToNext}</b><span>DAYS UNTIL NEXT RACE</span></div>}
            {upcoming.length ? upcoming.slice(0,5).map(r => <div className="mini-race" key={r.id}><div className="date-tile"><b>{r.date.startsWith("2099") ? "??" : format(parseISO(r.date), "dd")}</b><span>{r.date.startsWith("2099") ? "TBA" : format(parseISO(r.date), "MMM").toUpperCase()}</span></div><div className="row-main"><b>{r.name}</b><span>{formatRaceRange(r.date, r.endDate)} · {r.location || "Location not added"} · {r.distance}</span></div><span className="status registered">REGISTERED</span></div>) : <div className="chart-empty">No upcoming races yet. Add your first registration.</div>}</div>
            <div className="side-panels"><div className="panel sponsor-panel"><div className="sponsor-tag"><Star size={10}/> SAMPLE PARTNER SLOT</div><h3>Featured race partner</h3><p>Example placement only. Replace this card with a real, disclosed sponsor and destination link.</p><a href="https://worldathletics.org/" target="_blank" rel="noreferrer" className="secondary-button small">EXPLORE RUNNING</a></div><div className="panel next-panel"><div className="eyebrow">QUICK ACTION</div><h3>Booked somewhere else?</h3><p>Save the event here with its booking website, confirmation number and payment details so you never lose track.</p><div className="quick-actions"><button className="primary-button small" onClick={() => setModal({kind:"race"})}>ADD DETAILS</button><button type="button" onClick={() => setModal({kind:"import"})}>SMART IMPORT</button></div></div></div></div>
        </div>}
        {tab === "races" && <section className="section-page"><div className="section-heading"><div><div className="eyebrow">YOUR REGISTRATIONS, ALL IN ONE PLACE</div><h1>Race calendar</h1><p>Keep past and upcoming races together — including your Time Capsule photos.</p></div><div className="top-action-group"><button className="secondary-button" onClick={exportRaceCalendarPdf}>{isPro ? <Download size={14}/> : <Lock size={14}/>} EXPORT PDF {isPro && <span className="pro-badge-small">DEMO</span>}</button><button className="primary-button" onClick={() => setModal({kind:"race"})}><Plus size={17}/> ADD RACE</button></div></div>
          <div className="race-toolbar"><div className="filter-tabs">{(["all","upcoming","past"] as Filter[]).map(f => <button key={f} className={filter===f?"chosen":""} onClick={()=>setFilter(f)}>{f === "all" ? "All races" : f === "upcoming" ? "Upcoming" : "Past races"}</button>)}</div><label className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search race, city, booking site…"/></label></div>
          {grouped.length ? <div className="race-groups">{grouped.map(([date, entries]) => <div className="race-group" key={date}><div className="group-date"><div className="date-tile"><b>{date.startsWith("2099") ? "??" : format(parseISO(date),"dd")}</b><span>{date.startsWith("2099") ? "TBA" : format(parseISO(date),"MMM").toUpperCase()}</span></div><div><b>{date.startsWith("2099") ? "Date Unconfirmed" : format(parseISO(date),"EEEE, dd MMMM yyyy")}</b><span>{entries.length > 1 ? `${entries.length} races booked on this date` : "1 race"}</span></div>{entries.length > 1 && <span className="same-day-badge">SAME-DAY BOOKINGS</span>}</div>
              {entries.map(r => <RaceCard key={r.id} race={r} onImageClick={setLightbox} onEdit={()=>setModal({kind:"race", data: r})} onDelete={()=>removeRace(r.id)} onToggleChecklist={(itemId, done) => r.id !== undefined && toggleChecklistItem(r.id, itemId, done)}/>)}</div>)}</div> : <div className="empty-state"><div className="empty-icon"><Flag size={25}/></div><h3>No races found</h3><p>{search ? "Try another search term or change the filter." : "Add your first race registration, whether booked online or directly with an organiser."}</p><button className="primary-button" onClick={()=>setModal({kind:"race"})}><Plus size={16}/> ADD A RACE</button></div>}
        </section>}
        {tab === "medals" && <Section title="Medal cabinet" eyebrow="YOUR FINISH-LINE MEMORIES" description="Keep a record of the medals and achievements you have earned." action="Add medal" onAdd={()=>setModal({kind:"medal"})}>{medals.length ? <div className="global-grid">{medals.map(m=><article className="global-card" key={m.id}>
          {m.imageData ? <Thumbnail src={m.imageData} label="Medal photo" onClick={() => setLightbox(m.imageData!)}/> : <div className="medal-placeholder"><Trophy size={34}/></div>}
          <div className="global-card-info"><b>{m.name}</b><span>{m.event || "Race achievement"}</span><small>{fmtDate(m.date)}</small></div>
          <button className="text-danger" onClick={()=>removeMedal(m.id)}>Remove</button>
        </article>)}</div> : <div className="empty-state"><div className="empty-icon"><Medal size={25}/></div><h3>Your cabinet is waiting</h3><p>Save your first finisher medal or virtual race achievement.</p><button className="primary-button" onClick={()=>setModal({kind:"medal"})}><Plus size={16}/> ADD A MEDAL</button></div>}</Section>}
        {tab === "gear" && <section className="section-page"><div className="section-heading"><div><div className="eyebrow">RUNNER ESSENTIALS</div><h1>Gear Vault</h1><p>Browse example gear categories for training and race day.</p></div><span className="demo-disclosure">EXAMPLE LINKS · NOT AFFILIATE LINKS</span></div><div className="shoe-locker-section"><div className="section-heading"><div><div className="eyebrow">YOUR MILEAGE TRACKER</div><h2>Shoe Locker</h2><p>Race distance is totaled from completed races with shoes recorded.</p></div></div>{shoeLocker.length ? <div className="shoe-locker-grid">{shoeLocker.map(shoe => <article className="panel shoe-locker-card" key={shoe.name}><div className="gear-icon shoe-icon"><Footprints size={22}/></div><div className="shoe-locker-name">{shoe.name}</div><span className="shoe-races-count">{shoe.racesCount} {shoe.racesCount === 1 ? "RACE" : "RACES"}</span><div className="shoe-km"><b className={shoe.km > 300 ? "shoe-km-warning" : ""}>{shoe.km.toFixed(1)}</b><small>RACE KMs</small></div>{shoe.km > 300 && <div className="shoe-warning"><span aria-hidden="true">!</span> Consider checking shoe wear</div>}</article>)}</div> : <div className="empty-state shoe-empty"><p>Completed races with shoe details will appear here. Add shoes in the Race Vault to track race mileage.</p></div>}</div><div className="gear-grid">{affiliateGear.map(item => <article className="panel gear-card" key={item.id}><div className="gear-icon"><ShoppingBag size={23}/></div><div className="eyebrow">{item.type}</div><h3>{item.name}</h3><p>{item.description}</p><a className="secondary-button small" href={item.url} target="_blank" rel="noreferrer">BROWSE EXAMPLES <ExternalLink size={14}/></a></article>)}</div><div className="panel support-panel"><div><div className="eyebrow">LIKE THIS PROJECT?</div><h3>Support the maker</h3><p>This is a generic placeholder link. Replace it with your own support profile before sharing.</p></div><a className="primary-button small" href="https://www.buymeacoffee.com/" target="_blank" rel="noreferrer"><Coffee size={15}/> SUPPORT PLACEHOLDER</a></div></section>}
      </>}
      <footer className="footer"><span>OUT OF OFFICE PACE</span><span>BUILT FOR YOUR RACE JOURNEY · YOUR DATA STAYS ON THIS DEVICE</span></footer></div>
    </main><nav className="mobile-nav">{nav.map(n=><button key={n.id} className={tab===n.id?"selected":""} onClick={()=>setTab(n.id)}><n.icon size={18}/>{n.label}</button>)}</nav>
    {lightbox && <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
      <div className="lightbox-content" onClick={e => e.stopPropagation()}>
        <button type="button" className="icon-button close-lightbox" aria-label="Close image preview" onClick={() => setLightbox(null)}><X size={24}/></button>
        <img src={lightbox} alt="Expanded race or medal photo"/>
        <button type="button" onClick={() => downloadPhoto(lightbox)} className="primary-button lightbox-download"><Download size={16}/> DOWNLOAD PHOTO</button>
      </div>
    </div>}
    {importReview && <ImportPreviewModal review={importReview} setCandidates={candidates => setImportReview(current => current ? { ...current, candidates } : current)} close={() => setImportReview(null)} confirm={confirmImport}/>}
    {showWrapped && <WrappedModal races={races} medals={medals} close={() => setShowWrapped(false)} />}
    {modal && (modal.kind === "settings" ? <SettingsModal close={() => setModal(null)} isPro={isPro} onActivate={handleUpgrade} onDeactivate={() => {localStorage.removeItem("ooo_pro");setIsPro(false);}} onPreviewWrapped={() => {setModal(null);setShowWrapped(true);}} handleShareBackup={exportData}/> : <Modal kind={modal.kind} initialData={modal.data} close={()=>setModal(null)} openImport={() => setModal({kind:"import"})} saved={async()=>{setModal(null);await refresh();}} exportData={exportData} importData={importData}/> )}
  </div>;
}

function ImportPreviewModal({review, setCandidates, close, confirm}: {
  review: ImportReview;
  setCandidates: (candidates: ImportCandidate[]) => void;
  close: () => void;
  confirm: (candidates: ImportCandidate[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { candidates } = review;
  const toImport = candidates.filter(candidate => candidate.action === "import").length;
  const toUpdate = candidates.filter(candidate => candidate.action === "update").length;

  function updateCandidate(id: string, changes: Partial<ImportCandidate>) {
    setCandidates(candidates.map(candidate => candidate.id === id ? { ...candidate, ...changes } : candidate));
  }

  async function applyImport() {
    setBusy(true);
    try {
      await confirm(candidates);
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal import-preview-modal" role="dialog" aria-modal="true" aria-labelledby="import-preview-title">
      <div className="modal-head">
        <div><div className="eyebrow">SMART IMPORT</div><h2 id="import-preview-title">Review races</h2></div>
        <button type="button" className="icon-button" aria-label="Close import preview" disabled={busy} onClick={close}><X size={19}/></button>
      </div>
      <div className="demo-notice">
        <ShieldCheck size={19}/>
        <p><b>Review before importing</b><br/>{candidates.length} unique race(s) found. Existing records default to skip. Updates merge the backup’s non-empty details, race memories, and photos; when multiple saved entries match one event, choosing merge consolidates them into one entry.</p>
      </div>
      {review.mergedDuplicates > 0 && <p className="import-skipped-note">{review.mergedDuplicates} repeated backup row(s) have been merged, keeping the details and photos they contain.</p>}
      {review.invalidRows > 0 && <p className="import-skipped-note">{review.invalidRows} invalid row(s) will be skipped.</p>}
      <div className="import-table-container">
        <table className="import-table">
          <thead><tr><th scope="col">DATE</th><th scope="col">RACE</th><th scope="col">MATCH</th><th scope="col">BOOKING ID</th><th scope="col">ACTION</th></tr></thead>
          <tbody>{candidates.map(candidate => {
            const duplicate = candidate.existingId !== undefined;
            const hasPhotos = Boolean(candidate.race.bibImage || candidate.race.medalImage || candidate.race.finisherPhoto);
            return <tr key={candidate.id} className={duplicate ? "duplicate-row" : undefined}>
              <td className="it-date"><b>{format(parseISO(candidate.race.date), "MMM dd")}</b><span>{candidate.race.endDate ? formatRaceRange(candidate.race.date, candidate.race.endDate) : format(parseISO(candidate.race.date), "yyyy")}</span></td>
              <td className="it-name"><b>{candidate.race.name}</b><span>{candidate.race.distance} · {candidate.race.location || "Location not provided"}</span></td>
              <td>{duplicate ? <span className="import-match duplicate">{candidate.existingIds.length > 1 ? `EXISTS · ${candidate.existingIds.length} RECORDS` : "EXISTS"}{hasPhotos ? " · PHOTOS" : ""}</span> : <span className="import-match">{hasPhotos ? "NEW · PHOTOS" : "NEW"}</span>}</td>
              <td><input className="import-booking-id" aria-label={`Booking ID for ${candidate.race.name}`} value={candidate.race.bookingId ?? ""} onChange={event => updateCandidate(candidate.id, {
                race: { ...candidate.race, bookingId: event.target.value },
                bookingIdEdited: true,
              })}/></td>
              <td><select aria-label={`Import action for ${candidate.race.name}`} value={candidate.action} disabled={busy} onChange={event => updateCandidate(candidate.id, { action: event.target.value as ImportAction })}>
                {duplicate ? <><option value="skip">Skip · keep existing</option><option value="update">{candidate.existingIds.length > 1 ? "Merge details + duplicates" : "Merge backup details"}</option></> : <><option value="import">Import as new</option><option value="skip">Skip</option></>}
              </select></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="modal-actions import-preview-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || toImport + toUpdate === 0} onClick={() => void applyImport()}>{busy ? "IMPORTING…" : `APPLY ${toImport} ADD · ${toUpdate} UPDATE`}</button>
      </div>
    </section>
  </div>;
}

function SettingsModal({close, isPro, onActivate, onDeactivate, onPreviewWrapped, handleShareBackup}: {close: () => void; isPro: boolean; onActivate: (key: string) => void; onDeactivate: () => void; onPreviewWrapped: () => void; handleShareBackup: () => Promise<void>}) {
  const [key, setKey] = useState("");

  return <div className="modal-backdrop" onMouseDown={e => { if(e.target === e.currentTarget) close(); }}><div className="modal settings-modal"><div className="modal-head"><div><div className="eyebrow">APP SETTINGS</div><h2>Pro preview</h2></div><button type="button" className="icon-button" aria-label="Close settings" onClick={close}><X size={19}/></button></div>
    <div className="smart-backup-card"><div className="smart-backup-icon"><Send size={18}/></div><div className="smart-backup-copy"><b>Smart Share Backup</b><p>Share a JSON backup with Mail, WhatsApp, or another available app. On unsupported browsers, it downloads instead.</p></div><button type="button" className="primary-button" onClick={() => void handleShareBackup()}><Share size={15}/> SHARE BACKUP</button></div>
    <div className="demo-notice"><ShieldCheck size={19}/><p><b>Local demo access only</b><br/>This mock key only unlocks a preview on this device. It does not verify a payment, contact a store, or create a real subscription.</p></div>
    {isPro ? <div className="pro-active"><b>PDF export preview enabled</b><span>Print the current race calendar and choose “Save as PDF” in your browser.</span><button type="button" className="secondary-button" onClick={onDeactivate}>RESET DEMO ACCESS</button></div> : <form onSubmit={e => {e.preventDefault();onActivate(key);}}><label className="field"><span>Demo access key</span><input value={key} onChange={e => setKey(e.target.value)} placeholder="Enter demo key" autoComplete="off"/></label><p className="settings-hint">Preview key: <code>PACE-PRO-2026</code></p><div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button className="primary-button">ENABLE DEMO</button></div></form>}
    <div className="wrapped-preview-action"><p>Preview the current-year recap now. This uses your saved race and medal data and does not add sample records.</p><button type="button" className="secondary-button" onClick={onPreviewWrapped}><Sparkles size={14}/> PREVIEW YEAR WRAPPED</button></div>
  </div></div>;
}

function Onboarding({close}: {close: () => void}) {
  const [step, setStep] = useState(0);
  const slides = [
    {title: "Welcome to your race vault.", description: "Keep race plans, finish times, medals, and the moments you want to remember together.", icon: <Medal size={48}/>},
    {title: "Your races, your gear.", description: "Record the shoes and watch you raced in, track your packing checklist, and make a shareable race story.", icon: <Share size={48}/>},
    {title: "Private by design.", description: "Your race data and photos are stored in this browser on this device. There is no account or cloud sync.", icon: <ShieldCheck size={48}/>}
  ];

  function finish() {
    localStorage.setItem("ooo_onboarded", "true");
    close();
  }

  return <div className="onboarding-overlay"><section className="onboarding-card" aria-label="Welcome to Out Of Office Pace">
    <div className="onboarding-icon">{slides[step].icon}</div>
    <div className="eyebrow">OUT OF OFFICE PACE · {step + 1} / {slides.length}</div>
    <h2>{slides[step].title}</h2><p>{slides[step].description}</p>
    <div className="onboarding-dots" aria-label={`Slide ${step + 1} of ${slides.length}`}>{slides.map((slide, index) => <span key={slide.title} className={index === step ? "dot active" : "dot"}/>)}</div>
    <div className="onboarding-actions">{step < slides.length - 1 ? <><button type="button" className="primary-button full-width" onClick={() => setStep(current => current + 1)}>NEXT</button><button type="button" className="onboarding-skip" onClick={finish}>SKIP INTRO</button></> : <button type="button" className="primary-button full-width" onClick={finish}>LET'S RUN</button>}</div>
  </section></div>;
}

function WrappedModal({races, medals, close}: {races: Race[]; medals: MedalType[]; close: () => void}) {
  const yearRaces = races.filter(race => race.status === "completed" && (race.endDate ?? race.date).startsWith(currentYear));
  const yearMedals = medals.filter(medal => medal.date.startsWith(currentYear));
  const yearKm = yearRaces.reduce((total, race) => total + (distanceToKm(race.distance) ?? 0), 0);

  return <div className="wrapped-overlay" role="dialog" aria-modal="true" aria-labelledby="wrapped-title">
    <button type="button" className="icon-button close-wrapped" aria-label="Close year in review" onClick={close}><X size={24}/></button>
    <div className="wrapped-content"><header className="wrapped-header"><Sparkles size={32} color="var(--lime)"/><h1 id="wrapped-title">{currentYear} WRAPPED</h1><p>A look back at your year in running.</p></header>
      <div className="wrapped-stats-grid">
        <div className="wrapped-stat"><b>{yearRaces.length}</b><span>FINISH LINES CROSSED</span></div>
        <div className="wrapped-stat"><b>{yearKm > 0 ? Number(yearKm.toFixed(1)) : 0}</b><span>RACE KILOMETRES</span></div>
        <div className="wrapped-stat"><b>{yearMedals.length}</b><span>MEDALS EARNED</span></div>
      </div>
      <button type="button" className="primary-button" onClick={close}>BACK TO CALENDAR</button>
    </div>
  </div>;
}

function Stat({label,value,unit,icon:Icon}:any){return <div className="stat-card"><div className="stat-top"><span>{label}</span><Icon size={18}/></div><div className="stat-value">{value}<small>{unit}</small></div><div className="stat-accent lime"/></div>}
function Section({title,eyebrow,description,action,onAdd,children}:any){return <section className="section-page"><div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><button className="primary-button" onClick={onAdd}><Plus size={17}/>{action.toUpperCase()}</button></div>{children}</section>}

function MetricCard({label, value}: {label: string; value: string}) {
  return <div className="global-metric-card"><small>{label}</small><b>{value}</b></div>;
}

function Thumbnail({src, label, onClick}: {src: string; label?: string; onClick?: () => void}) {
  const image = <img src={src} alt={label || "Photo"} />;
  return <div className="global-thumbnail">
    {onClick
      ? <button type="button" className="thumbnail-button clickable-img" onClick={onClick} aria-label={`View ${label || "photo"}`}>{image}</button>
      : image}
    {label && <small>{label}</small>}
  </div>;
}

function RaceCard({race:r, onEdit, onDelete, onImageClick, onToggleChecklist}: {race: Race; onEdit: () => void; onDelete: () => void; onImageClick: (image: string) => void; onToggleChecklist: (itemId: string, done: boolean) => void}) {
  const [vaultOpen, setVaultOpen] = useState(false);
  const hasMemories = Boolean(r.chipTime || r.supportCrew || r.postRaceMeal || r.weatherVibe || r.shoes || r.watch || r.avgPace || r.avgHr || r.bibImage || r.medalImage || r.finisherPhoto);

  return <div className="race-card"><div className="race-card-main"><div className="race-title-line"><b>{r.name}</b><span className={`status ${r.status}`}>{r.status}</span></div><div className="race-meta">{r.endDate && r.endDate !== r.date ? `${formatRaceRange(r.date, r.endDate)} · ` : ""}{r.distance} {r.location ? `· ${r.location}` : ""} {r.organizer ? `· Organiser: ${r.organizer}` : ""}</div><div className="booking-grid">{r.bookingPlatform && <span><small>BOOKED VIA</small><b>{r.bookingPlatform}</b></span>}{r.bookingId && <span><small>BOOKING / ORDER ID</small><b>{r.bookingId}</b></span>}{r.bib && <span><small>BIB NUMBER</small><b>{r.bib}</b></span>}{r.amountPaid !== undefined && <span><small>AMOUNT PAID</small><b>₹{r.amountPaid.toLocaleString("en-IN")}</b></span>}</div>{r.notes && <p className="race-notes">{r.notes}</p>}
    {r.status === "registered" && Boolean(r.checklist?.length) && <div className="card-checklist"><div className="form-divider">PRE-RACE CHECKLIST</div>{r.checklist!.map(item => <label key={item.id} className="checklist-item-display"><input type="checkbox" checked={item.done} onChange={event => onToggleChecklist(item.id, event.target.checked)}/><span className={item.done ? "done" : ""}>{item.text}</span></label>)}</div>}
    {r.status === "completed" && hasMemories && <>
      <div className="vault-toggle-container">
        <button type="button" className="vault-toggle-btn" aria-expanded={vaultOpen} onClick={() => setVaultOpen(open => !open)}>
          {vaultOpen ? "HIDE RACE VAULT" : "VIEW RACE VAULT"}
          <ChevronDown size={14} className={vaultOpen ? "vault-chevron open" : "vault-chevron"} />
        </button>
      </div>
      {vaultOpen && <div className="time-capsule-display">
        <div className="form-divider">RACE VAULT MEMORIES</div>
        <div className="global-metric-grid">
          {r.chipTime && <MetricCard label="OFFICIAL CHIP TIME" value={r.chipTime}/>}
          {r.postRaceMeal && <MetricCard label="POST-RACE CELEBRATION" value={r.postRaceMeal}/>}
          {r.supportCrew && <MetricCard label="SUPPORT CREW" value={r.supportCrew}/>}
          {r.weatherVibe && <MetricCard label="WEATHER & VIBE" value={r.weatherVibe}/>}
          {r.shoes && <MetricCard label="SHOES WORN" value={r.shoes}/>}
          {r.watch && <MetricCard label="WATCH USED" value={r.watch}/>}
          {r.avgPace && <MetricCard label="AVERAGE PACE" value={`${r.avgPace}/km`}/>}
          {r.avgHr && <MetricCard label="AVERAGE HEART RATE" value={`${r.avgHr} bpm`}/>}
        </div>
        <div className="global-thumbnail-grid">
          {r.bibImage && <Thumbnail src={r.bibImage} label="YOUR BIB" onClick={() => onImageClick(r.bibImage!)}/>}
          {r.medalImage && <Thumbnail src={r.medalImage} label="YOUR MEDAL" onClick={() => onImageClick(r.medalImage!)}/>}
          {r.finisherPhoto && <Thumbnail src={r.finisherPhoto} label="FINISH LINE" onClick={() => onImageClick(r.finisherPhoto!)}/>}
        </div>
      </div>}
    </>}
  </div><div className="race-card-actions">{r.status === "completed" && Boolean(r.finisherPhoto || r.medalImage || r.bibImage) && <button type="button" className="icon-button highlight-action" onClick={() => shareToIG(r)} title="Create Instagram Story" aria-label="Create Instagram Story"><Share size={16}/></button>}{r.bookingUrl && <a className="icon-button" href={r.bookingUrl} target="_blank" rel="noreferrer" title="Open booking website"><ExternalLink size={16}/></a>}<button className="icon-button" onClick={onEdit} title="Edit / Add Memories"><Edit2 size={16}/></button><button className="icon-button danger" onClick={onDelete} title="Delete race"><Trash2 size={16}/></button></div></div>
}

function Modal({kind, initialData, close, openImport, saved, exportData, importData}:any) {
  const isEdit = !!initialData;
  const [form, setForm] = useState<any>(initialData || { date: today, status: "registered", distance: "5K", checklist: [] }); 
  const [busy, setBusy] = useState(false);
  const [importFlow, setImportFlow] = useState<"choose" | "gmail" | "other">("choose");
  const [copied, setCopied] = useState(false);
  const [checkText, setCheckText] = useState("");
  const change = (e:any) => setForm((p:any) => ({...p, [e.target.name]: e.target.value}));

  function addChecklistItem() {
    const text = checkText.trim();
    if (!text) return;
    setForm((current: any) => ({...current, checklist: [...(current.checklist || []), {id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text, done: false}]}));
    setCheckText("");
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      alert("Clipboard access was denied. You can select and copy the text manually.");
    }
  }

  const geminiPrompt = `Act as a JSON data extractor. Read my recent race confirmation emails and output ONLY a valid JSON object with a "races" array, matching this exact schema: { "name": "Race Name", "date": "YYYY-MM-DD", "endDate": "YYYY-MM-DD or omit for one-day events", "distance": "5K", "location": "City or Virtual", "status": "registered", "bookingPlatform": "App name", "bookingId": "12345" }. Use one race object per registration. For multi-day virtual events, put the participation window's first day in "date" and its last day in "endDate"; do not create one race object per day. Do not use markdown.`;
  const jsonTemplate = `{
  "races": [
    {
      "name": "Event Name",
      "date": "2026-12-31",
      "endDate": "2027-01-02",
      "distance": "10K",
      "location": "City",
      "status": "registered"
    }
  ]
}`;
  
  async function handleImage(e: React.ChangeEvent<HTMLInputElement>, field: string) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const base64 = await compressImage(file, 2500);
      setForm((p:any) => ({ ...p, [field]: base64 }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to process image.");
    } finally { setBusy(false); }
  }

  async function submit(e:React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      if (kind === "race") {
        if (form.endDate && form.endDate < form.date) {
          alert("The end date must be on or after the start date.");
          return;
        }
        const payload = { ...form, amountPaid: form.amountPaid === "" || form.amountPaid === undefined ? undefined : Number(form.amountPaid) };
        if (isEdit) await db.races.update(initialData.id, payload);
        else await db.races.add(payload);
      }
      if (kind === "medal") {
        if (isEdit) await db.medals.update(initialData.id, form);
        else await db.medals.add(form);
      }
      await saved();
    } finally { setBusy(false); }
  }

  const title = kind === "import" ? "The Almost-Magic Import" : kind === "race" ? (isEdit ? "Edit Race & Memories" : "Add Race / Booking") : "Add a Medal";
  
  return <div className="modal-backdrop" onMouseDown={e => { if(e.target === e.currentTarget) close(); }}><div className="modal"><div className="modal-head"><div><div className="eyebrow">{kind === "import" ? "DATA MIGRATION" : "YOUR RACE JOURNEY"}</div><h2>{title}</h2></div><button type="button" className="icon-button" onClick={close}><X size={19}/></button></div>
    {kind === "import" ? <div className="import-wizard">
      {importFlow === "choose" && <div className="wizard-step">
        <p>AI is brilliant, but until we hire a robot butler, Smart Import needs a little teamwork. Where are your race confirmations?</p>
        <div className="wizard-buttons">
          <button type="button" className="primary-button" onClick={() => { setCopied(false); setImportFlow("gmail"); }}>I USE GMAIL</button>
          <button type="button" className="secondary-button" onClick={() => { setCopied(false); setImportFlow("other"); }}>OTHER PROVIDER</button>
        </div>
      </div>}
      {importFlow === "gmail" && <div className="wizard-step">
        <p>Open Gemini (or another AI assistant), connect Gmail if you choose, and paste this prompt. Review its output before importing.</p>
        <div className="code-snippet">
          <code>{geminiPrompt}</code>
          <button type="button" onClick={() => copyText(geminiPrompt)}>{copied ? <CheckCircle2 size={16}/> : <Copy size={16}/>} {copied ? "COPIED!" : "COPY PROMPT"}</button>
        </div>
        <p>Save the assistant's JSON response as a <code>.json</code> file, then upload it:</p>
        <label className="primary-button import-dropzone"><Upload size={16}/> UPLOAD JSON FILE<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void importData(file); }} /></label>
        <button type="button" className="secondary-button wizard-back" onClick={() => setImportFlow("choose")}>BACK</button>
      </div>}
      {importFlow === "other" && <div className="wizard-step">
        <p>Copy this JSON template, fill in your race details, save it as a <code>.json</code> file, and upload it below.</p>
        <div className="code-snippet">
          <pre>{jsonTemplate}</pre>
          <button type="button" onClick={() => copyText(jsonTemplate)}>{copied ? <CheckCircle2 size={16}/> : <Copy size={16}/>} {copied ? "COPIED!" : "COPY TEMPLATE"}</button>
        </div>
        <label className="primary-button import-dropzone"><Upload size={16}/> UPLOAD JSON FILE<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void importData(file); }} /></label>
        <button type="button" className="secondary-button wizard-back" onClick={() => setImportFlow("choose")}>BACK</button>
      </div>}
    </div> : <form onSubmit={submit}>
    {kind==="race" && <><Field label="Race / event name" name="name" value={form.name||""} onChange={change} placeholder="e.g. Bengaluru 10K" required/><div className="form-grid"><Field label="Start date" name="date" type="date" value={form.date||""} onChange={change} required/><Field label="End date (optional)" name="endDate" type="date" min={form.date || undefined} value={form.endDate||""} onChange={change}/></div><div className="form-grid"><Field label="Distance" name="distance" value={form.distance||""} onChange={change} placeholder="5K / 10K / HM"/><Field label="City / venue" name="location" value={form.location||""} onChange={change} placeholder="e.g. Bengaluru · Begur Lake"/></div><div className="form-grid"><Field label="Organiser" name="organizer" value={form.organizer||""} onChange={change} placeholder="Event organiser"/><label className="field"><span>Race status</span><select name="status" value={form.status||"registered"} onChange={change}><option value="registered">Registered / Paid</option><option value="interested">Interested / Not booked</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label></div>
      <div className="form-divider">BOOKING INFORMATION</div>
      <div className="form-grid"><Field label="Booked through" name="bookingPlatform" value={form.bookingPlatform||""} onChange={change} placeholder="e.g. Townscript"/><Field label="Booking ID" name="bookingId" value={form.bookingId||""} onChange={change} placeholder="Confirmation no."/></div><div className="form-grid"><Field label="Amount paid (₹)" name="amountPaid" type="number" step="0.01" value={form.amountPaid??""} onChange={change}/><Field label="BIB number" name="bib" value={form.bib||""} onChange={change}/></div><Field label="Booking confirmation URL" name="bookingUrl" type="url" value={form.bookingUrl||""} onChange={change} placeholder="https://…"/><Field label="Notes / reminders" name="notes" type="textarea" value={form.notes||""} onChange={change} placeholder="Kit collection details..." />
      
      {form.status === "completed" && <div className="global-upload-area">
        <div className="form-divider">RACE VAULT & MEMORIES</div>
        <div className="form-grid">
          <Field label="Official Chip Time" name="chipTime" value={form.chipTime||""} onChange={change} placeholder="e.g. 00:58:21"/>
          <Field label="Support Crew" name="supportCrew" value={form.supportCrew||""} onChange={change} placeholder="Who was there?"/>
          <Field label="Post-Race Celebration" name="postRaceMeal" value={form.postRaceMeal||""} onChange={change} placeholder="Dosa? Pizza?"/>
          <Field label="Weather & Vibe" name="weatherVibe" value={form.weatherVibe||""} onChange={change} placeholder="Poured rain, loved it!"/>
          <Field label="Shoes worn" name="shoes" value={form.shoes||""} onChange={change} placeholder="e.g. Asics Metaspeed Sky"/>
          <Field label="Watch used" name="watch" value={form.watch||""} onChange={change} placeholder="e.g. Garmin Forerunner"/>
          <Field label="Average pace (min/km)" name="avgPace" value={form.avgPace||""} onChange={change} placeholder="e.g. 5:30"/>
          <Field label="Average heart rate (bpm)" name="avgHr" type="number" min="1" max="250" value={form.avgHr||""} onChange={change} placeholder="e.g. 165"/>
        </div>
        <div className="global-upload-grid">
          <ImageUpload label="Snap Bib" field="bibImage" image={form.bibImage} onChange={handleImage} />
          <ImageUpload label="Snap Medal" field="medalImage" image={form.medalImage} onChange={handleImage} />
          <ImageUpload label="Finisher Selfie" field="finisherPhoto" image={form.finisherPhoto} onChange={handleImage} />
        </div>
      </div>}
      {form.status === "registered" && <div className="global-upload-area">
        <div className="form-divider">PRE-RACE PACKING LIST</div>
        <div className="checklist-input-row"><input value={checkText} onChange={event => setCheckText(event.target.value)} onKeyDown={event => {if (event.key === "Enter") {event.preventDefault();addChecklistItem();}}} placeholder="e.g. Charge watch, pack gels"/><button type="button" className="secondary-button" aria-label="Add checklist item" onClick={addChecklistItem}><Plus size={14}/></button></div>
        <div className="checklist-items">{(form.checklist || []).map((item: ChecklistItem) => <div key={item.id} className="checklist-item"><input type="checkbox" checked={item.done} aria-label={`Mark ${item.text} ${item.done ? "incomplete" : "complete"}`} onChange={event => setForm((current: any) => ({...current, checklist: current.checklist.map((entry: ChecklistItem) => entry.id === item.id ? {...entry, done: event.target.checked} : entry)}))}/><span className={item.done ? "done" : ""}>{item.text}</span><button type="button" aria-label={`Remove ${item.text}`} onClick={() => setForm((current: any) => ({...current, checklist: current.checklist.filter((entry: ChecklistItem) => entry.id !== item.id)}))}><X size={14}/></button></div>)}</div>
      </div>}
    </>}
    {kind==="medal" && <><Field label="Medal / achievement name" name="name" value={form.name||""} onChange={change} placeholder="e.g. First 5K finisher" required/><div className="form-grid"><Field label="Date earned" name="date" type="date" value={form.date||""} onChange={change} required/><Field label="Event" name="event" value={form.event||""} onChange={change} placeholder="Event name"/></div><ImageUpload label="Upload Medal Photo" field="imageData" image={form.imageData} onChange={handleImage} /></>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy}>{busy?"SAVING…":"SAVE"}</button></div>
    {!isEdit && <div className="backup-tools"><button type="button" onClick={exportData}><Download size={14}/> Export backup</button><label><Upload size={14}/> Import backup<input type="file" accept="application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void importData(file); }}/></label><button type="button" onClick={openImport}><Copy size={14}/> Smart Import</button></div>}
  </form>}
  </div></div>;
}

function Field({label,...props}:any){return <label className="field"><span>{label}</span>{props.type==="textarea"?<textarea {...props}/>:<input {...props}/>}</label>}
function ImageUpload({label, field, image, onChange}:any) {
  return (
    <label className="global-upload-btn">
      {/* This inline style guarantees the ugly default browser button is completely hidden */}
      <input 
        type="file" 
        accept="image/*" 
        onChange={(e) => onChange(e, field)} 
        style={{ display: "none" }} 
      />
      
      {image ? (
        <img src={image} alt="Preview" className="global-preview-img" />
      ) : (
        <div className="global-upload-placeholder">
          <Camera size={22} strokeWidth={1.5} />
          <span>{label}</span>
        </div>
      )}
    </label>
  );
}