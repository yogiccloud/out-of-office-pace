import Dexie, { type Table } from "dexie";

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type Race = {
  id?: number;
  name: string;
  date: string;
  distance: string;
  location: string;
  status: "registered" | "completed" | "interested" | "cancelled";
  organizer?: string;
  bookingPlatform?: string;
  bookingId?: string;
  amountPaid?: number;
  bookingUrl?: string;
  bib?: string;
  notes?: string;

  // --- THE TIME CAPSULE FIELDS ---
  chipTime?: string;         // Official finish time (e.g., "00:58:21")
  supportCrew?: string;      // Who cheered you on (e.g., "Ananya at the finish line")
  postRaceMeal?: string;     // The celebration meal (e.g., "Dosa & Filter Coffee")
  weatherVibe?: string;      // Weather and feelings (e.g., "Poured rain, loved it!")

  // --- GEAR TAGGING ---
  shoes?: string;
  watch?: string;
  avgPace?: string;
  avgHr?: string;

  // --- PRE-RACE CHECKLIST ---
  checklist?: ChecklistItem[];
  
  // --- THE DIGITAL VAULT (Compressed Base64 Images) ---
  bibImage?: string;         // Photo of the physical BIB
  medalImage?: string;       // Photo of the Finishers Medal
  finisherPhoto?: string;    // Action shot or Finish Line Selfie
};

export type Activity = { id?: number; date: string; distance: number; durationMinutes: number; notes?: string };

export type Medal = { 
  id?: number; 
  name: string; 
  date: string; 
  event?: string; 
  raceId?: number;           // Links directly to the Race record
  imageData?: string; 
};

export type Goal = { id?: number; title: string; targetKm: number; currentKm: number; deadline?: string };

class PaceDatabase extends Dexie {
  races!: Table<Race, number>;
  activities!: Table<Activity, number>;
  medals!: Table<Medal, number>;
  goals!: Table<Goal, number>;
  
  constructor() {
    super("OutOfOfficePace");
    this.version(1).stores({ races: "++id, date, status", activities: "++id, date", medals: "++id, date", goals: "++id, deadline" });
    this.version(2).stores({ races: "++id, date, status, bookingPlatform" });
    
    // Version 3: Adds the raceId index to medals to easily link the cabinet to the calendar
    this.version(3).stores({ medals: "++id, date, raceId" }); 

    // Version 4 adds fields stored within race records; no index migration is needed.
    this.version(4).upgrade(() => {});
  }
}

export const db = new PaceDatabase();