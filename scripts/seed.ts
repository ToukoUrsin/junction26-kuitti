// Deterministic demo data. SEED=small (default) or SEED=large. Reads DATABASE_PATH.
// Dates are laid out relative to SEED_DATE (YYYY-MM-DD, default: today in UTC).
import { hashPassword } from "../src/auth";
import { getDb, openDb, resetSchema } from "../src/db";
import { addDays, isDate, today } from "../src/lib/util";

export type SeedSize = "small" | "large";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORKSPACES: { name: string; legal: string; city: string; prefix: string; domain: string }[] = [
  { name: "Nordlys Studio", legal: "Nordlys Studio Oy", city: "Helsinki", prefix: "NS", domain: "nordlys.test" },
  { name: "Harbour & Co", legal: "Harbour & Co Ltd", city: "Tallinn", prefix: "HC", domain: "harbour.test" },
  { name: "Pinewood Analytics", legal: "Pinewood Analytics Oy", city: "Tampere", prefix: "PA", domain: "pinewood.test" },
  { name: "Saltmarsh Design", legal: "Saltmarsh Design AB", city: "Stockholm", prefix: "SD", domain: "saltmarsh.test" },
  { name: "Kettle & Crane", legal: "Kettle & Crane ApS", city: "Copenhagen", prefix: "KC", domain: "kettlecrane.test" },
  { name: "Aalto Bureau", legal: "Aalto Bureau Oy", city: "Espoo", prefix: "AB", domain: "aaltobureau.test" },
  { name: "Lumen Works", legal: "Lumen Works Oy", city: "Turku", prefix: "LW", domain: "lumenworks.test" },
  { name: "Northbound Media", legal: "Northbound Media AS", city: "Oslo", prefix: "NM", domain: "northbound.test" },
  { name: "Fjell Partners", legal: "Fjell Partners AS", city: "Bergen", prefix: "FP", domain: "fjell.test" },
  { name: "Copperleaf", legal: "Copperleaf Ltd", city: "Dublin", prefix: "CL", domain: "copperleaf.test" },
  { name: "Brightwater Labs", legal: "Brightwater Labs BV", city: "Rotterdam", prefix: "BL", domain: "brightwater.test" },
  { name: "Mint & Marble", legal: "Mint & Marble Oy", city: "Oulu", prefix: "MM", domain: "mintmarble.test" },
  { name: "Halla Architects", legal: "Halla Arkkitehdit Oy", city: "Helsinki", prefix: "HA", domain: "halla.test" },
  { name: "Tundra Digital", legal: "Tundra Digital Oy", city: "Rovaniemi", prefix: "TD", domain: "tundra.test" },
  { name: "Westbay Consulting", legal: "Westbay Consulting Ltd", city: "Edinburgh", prefix: "WC", domain: "westbay.test" },
  { name: "Kaski Translations", legal: "Kaski Translations Oy", city: "Jyväskylä", prefix: "KT", domain: "kaski.test" },
  { name: "Oakline Events", legal: "Oakline Events AB", city: "Gothenburg", prefix: "OE", domain: "oakline.test" },
  { name: "Riverstone Legal", legal: "Riverstone Legal Oy", city: "Helsinki", prefix: "RL", domain: "riverstone.test" },
  { name: "Polar Pixel", legal: "Polar Pixel Oy", city: "Lahti", prefix: "PP", domain: "polarpixel.test" },
  { name: "Greenfield Audio", legal: "Greenfield Audio ApS", city: "Aarhus", prefix: "GA", domain: "greenfield.test" },
  { name: "Ilmari Engineering", legal: "Ilmari Engineering Oy", city: "Vaasa", prefix: "IE", domain: "ilmari.test" },
  { name: "Seastack Studio", legal: "Seastack Studio Ltd", city: "Cork", prefix: "SS", domain: "seastack.test" },
  { name: "Birch & Field", legal: "Birch & Field Oy", city: "Porvoo", prefix: "BF", domain: "birchfield.test" },
  { name: "Arctic Code", legal: "Arctic Code AS", city: "Tromsø", prefix: "AC", domain: "arcticcode.test" },
  { name: "Vellamo Films", legal: "Vellamo Films Oy", city: "Kotka", prefix: "VF", domain: "vellamo.test" },
  { name: "Lakeside Bookkeeping", legal: "Lakeside Bookkeeping Oy", city: "Kuopio", prefix: "LB", domain: "lakeside.test" },
  { name: "Stoneware Collective", legal: "Stoneware Collective AB", city: "Malmö", prefix: "SC", domain: "stoneware.test" },
  { name: "Meridian Research", legal: "Meridian Research BV", city: "Utrecht", prefix: "MR", domain: "meridian.test" },
  { name: "Hollow Oak Games", legal: "Hollow Oak Games Oy", city: "Helsinki", prefix: "HO", domain: "hollowoak.test" },
  { name: "Kide Interiors", legal: "Kide Interiors Oy", city: "Hämeenlinna", prefix: "KI", domain: "kide.test" },
  { name: "Signal Hill", legal: "Signal Hill Ltd", city: "Galway", prefix: "SH", domain: "signalhill.test" },
  { name: "Tallgrass Studio", legal: "Tallgrass Studio AS", city: "Trondheim", prefix: "TS", domain: "tallgrass.test" },
  { name: "Ember Coffee Roasters", legal: "Ember Coffee Roasters Oy", city: "Tampere", prefix: "EC", domain: "ember.test" },
  { name: "Glasshouse UX", legal: "Glasshouse UX ApS", city: "Odense", prefix: "GU", domain: "glasshouse.test" },
  { name: "Ravn Strategy", legal: "Ravn Strategy AS", city: "Stavanger", prefix: "RS", domain: "ravn.test" },
  { name: "Solstice Wellness", legal: "Solstice Wellness Oy", city: "Joensuu", prefix: "SW", domain: "solstice.test" },
  { name: "Quayside Print", legal: "Quayside Print Ltd", city: "Belfast", prefix: "QP", domain: "quayside.test" },
  { name: "Heron Data", legal: "Heron Data Oy", city: "Espoo", prefix: "HD", domain: "herondata.test" },
  { name: "Marsh Lane Media", legal: "Marsh Lane Media Ltd", city: "Leeds", prefix: "ML", domain: "marshlane.test" },
  { name: "Ostrobothnia Timber", legal: "Pohjanmaan Puu Oy", city: "Seinäjoki", prefix: "OT", domain: "ostrotimber.test" },
];

const CLIENT_NAMES = [
  "Fazer Bakeries", "Kesko Retail Services", "Verkkokauppa Solutions", "Rautaruukki Steelworks", "Marimekko Studio",
  "Arabia Ceramics", "Helsinki Design Week", "Supercell Events", "Kone Lifts Nordic", "Finnair Cargo",
  "Iittala Glass", "Oura Health", "Wolt Logistics", "Nokian Tyres Service", "Valio Dairy",
  "Posti Parcel Network", "Stockmann Department Store", "Alko Wine Club", "Fiskars Garden", "Lapland Hotels",
  "Kalevala Jewelry", "Sanoma Learning", "Reaktor Labs", "Vincit Software", "Hartwall Beverages",
  "Lindström Workwear", "Ponsse Forest Machines", "Musti Pet Care", "Harvia Saunas", "Aalto University Foundation",
  "Nordea Private Banking", "Elisa Home", "Tokmanni Stores", "Kotipizza", "Gigantti Electronics",
  "Paulig Coffee", "Wärtsilä Marine", "Metsä Board", "Orion Pharma", "Huhtamäki Packaging",
  "Telia Business", "Ahlstrom Filters", "Tikkurila Paints", "Altia Spirits", "Onni Bus",
  "Moomin Characters", "Kaiku Health", "Lumene Cosmetics", "Rovio Studios", "Taaleri Energy",
  "Sitra Fund", "Port of Turku", "Visit Tampere", "Tallink Cruises", "Baltic Yachts",
  "Nordic Morning", "Vaisala Instruments", "Kemppi Welding", "Suunto Outdoor", "Ekokem Recycling",
  "Pihlajalinna Clinics", "Mehiläinen Care", "Fortum Charge", "Helen Energy", "YIT Construction",
  "Skanska Nordic", "Hesburger", "Fiskars Craft", "Sinebrychoff", "Raisio Foods",
];

const CONTACTS = [
  "Aino Laine", "Mikko Korhonen", "Sofia Nieminen", "Juho Mäkelä", "Emma Hämäläinen", "Lauri Koskinen",
  "Ella Heikkinen", "Oskari Järvinen", "Helmi Lehtonen", "Eero Salminen", "Ida Lindqvist", "Niklas Berg",
  "Sara Holm", "Anton Eklund", "Maja Nyström", "Viktor Sandberg", "Clara Murphy", "Liam O'Connor",
  "Freya Jensen", "Magnus Dahl", "Ingrid Solberg", "Henrik Lund", "Tuuli Rantanen", "Kasper Aalto",
];

const STREETS = ["Mannerheimintie", "Aleksanterinkatu", "Hämeenkatu", "Itäinen Rantakatu", "Kauppakatu", "Satamakatu", "Pohjoisesplanadi", "Bulevardi", "Tehtaankatu", "Runeberginkatu"];
const POSTAL: Record<string, string> = { Helsinki: "00100", Espoo: "02100", Tampere: "33100", Turku: "20100", Oulu: "90100" };

const SERVICES: { d: string; unit: [number, number]; qty: [number, number]; hourly?: boolean }[] = [
  { d: "Design work (hours)", unit: [85, 120], qty: [4, 40], hourly: true },
  { d: "Frontend development (hours)", unit: [90, 135], qty: [6, 60], hourly: true },
  { d: "Project management (hours)", unit: [75, 105], qty: [2, 16], hourly: true },
  { d: "Strategy consultation (hours)", unit: [120, 180], qty: [2, 12], hourly: true },
  { d: "Copywriting (hours)", unit: [70, 95], qty: [3, 20], hourly: true },
  { d: "Brand workshop, half day", unit: [900, 1600], qty: [1, 2] },
  { d: "Usability testing session", unit: [450, 800], qty: [1, 4] },
  { d: "Photography, full day", unit: [950, 1400], qty: [1, 2] },
  { d: "Illustration set", unit: [600, 2400], qty: [1, 1] },
  { d: "Website hosting, 12 months", unit: [240, 480], qty: [1, 1] },
  { d: "Maintenance retainer, monthly", unit: [400, 1200], qty: [1, 3] },
  { d: "Stock image licences", unit: [35, 90], qty: [2, 12] },
  { d: "Print production", unit: [300, 1800], qty: [1, 1] },
  { d: "Travel expenses", unit: [60, 380], qty: [1, 1] },
  { d: "Analytics setup", unit: [500, 1500], qty: [1, 1] },
  { d: "Accessibility audit", unit: [1200, 2800], qty: [1, 1] },
  { d: "Content migration", unit: [400, 1600], qty: [1, 1] },
  { d: "Video editing (hours)", unit: [80, 110], qty: [4, 30], hourly: true },
];

const REFERENCES = ["", "", "", "PO 4471", "Spring campaign", "Website renewal", "PO 88213", "Annual report", "Q3 retainer", "Product launch", "PO 1209-B", "Rebrand phase 2"];

export interface SeedSummary {
  workspaces: number;
  users: number;
  clients: number;
  invoices: number;
  lineItems: number;
}

export async function seed(size: SeedSize = "small", anchor = today()): Promise<SeedSummary> {
  const rand = mulberry32(size === "large" ? 20261114 : 1114);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  resetSchema();
  const db = getDb();

  const wsCount = size === "large" ? 40 : 2;
  const invoicePlan = (i: number) => (size === "small" ? (i === 0 ? 42 : 38) : i === 0 ? 2000 : 76 + (i <= 36 ? 1 : 0));
  const clientPlan = (i: number) => (size === "small" ? (i === 0 ? 12 : 9) : i === 0 ? 60 : int(10, 18));
  const spanDays = (i: number) => (size === "small" ? 200 : i === 0 ? 1100 : 400);

  const aliceHash = await hashPassword("crashtest-alice");
  const bobHash = await hashPassword("crashtest-bob");
  // Members other than the two test accounts get a random password nobody knows.
  const lockedHash = await hashPassword(crypto.randomUUID());

  const insWs = db.query<{ id: number }, [string, string, string, string, string, string, string, number]>(
    `INSERT INTO workspaces (name, legal_name, address, vat_id, email, iban, invoice_prefix, payment_terms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insUser = db.query("INSERT INTO users (workspace_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)");
  const insClient = db.query<{ id: number }, [number, string, string, string, string, string, string]>(
    `INSERT INTO clients (workspace_id, name, contact_name, email, address, vat_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insInv = db.query<{ id: number }, [number, number, string, number, string, string, string, string | null, string, string]>(
    `INSERT INTO invoices (workspace_id, client_id, number, seq, status, issue_date, due_date, paid_at, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insLine = db.query("INSERT INTO line_items (invoice_id, position, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)");

  const summary: SeedSummary = { workspaces: 0, users: 0, clients: 0, invoices: 0, lineItems: 0 };

  db.transaction(() => {
    for (let w = 0; w < wsCount; w++) {
      const W = WORKSPACES[w]!;
      const vat = `FI${String(10000000 + Math.floor(rand() * 89999999))}`;
      const iban = `FI${int(10, 99)} ${int(1000, 9999)} ${int(1000, 9999)} ${int(10, 99)}`;
      const street = `${pick(STREETS)} ${int(1, 60)}`;
      const address = `${street}\n${POSTAL[W.city] ?? String(int(10, 99)) + "100"} ${W.city}`;
      const terms = pick([14, 14, 14, 21, 30]);
      const wsId = insWs.get(W.name, W.legal, address, vat, `billing@${W.domain}`, iban, W.prefix, terms)!.id;
      summary.workspaces++;

      const created = addDays(anchor, -spanDays(w) - 30);
      if (w === 0) {
        insUser.run(wsId, "Alice Mäkinen", "alice@nordlys.test", aliceHash, created);
        insUser.run(wsId, "Mikael Lind", "mikael@nordlys.test", lockedHash, created);
        summary.users += 2;
      } else if (w === 1) {
        insUser.run(wsId, "Bob Carter", "bob@harbour.test", bobHash, created);
        insUser.run(wsId, "Hanna Kask", "hanna@harbour.test", lockedHash, created);
        summary.users += 2;
      } else {
        const who = pick(CONTACTS);
        insUser.run(wsId, who, `${who.split(" ")[0]!.toLowerCase().replace(/[^a-z]/g, "")}@${W.domain}`, lockedHash, created);
        summary.users++;
      }

      // Clients: a deterministic shuffle of the name list.
      const names = [...CLIENT_NAMES];
      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [names[i], names[j]] = [names[j]!, names[i]!];
      }
      const clientIds: number[] = [];
      const nClients = Math.min(clientPlan(w), names.length);
      for (let i = 0; i < nClients; i++) {
        const contact = pick(CONTACTS);
        const name = names[i]!;
        const slug = name.split(" ")[0]!.toLowerCase().normalize("NFD").replace(/[^a-z]+/g, "");
        const city = pick(["Helsinki", "Espoo", "Tampere", "Turku", "Oulu"]);
        clientIds.push(
          insClient.get(
            wsId,
            name,
            contact,
            `${contact.split(" ")[0]!.toLowerCase().replace(/[^a-z]/g, "")}@${slug}.test`,
            `${pick(STREETS)} ${int(1, 80)}\n${POSTAL[city]} ${city}`,
            rand() < 0.8 ? `FI${String(10000000 + Math.floor(rand() * 89999999))}` : "",
            created,
          )!.id,
        );
        summary.clients++;
      }
      // Some clients get most of the work.
      const weighted = clientIds.flatMap((id, i) => Array(i < 4 ? 2 : 1).fill(id) as number[]);

      // Invoice dates, oldest first, so numbers follow dates.
      const n = invoicePlan(w);
      const dates = Array.from({ length: n }, () => addDays(anchor, -Math.floor(Math.pow(rand(), 1.15) * spanDays(w))));
      dates.sort();
      dates.forEach((issue, k) => {
        const seq = 1001 + k;
        const due = addDays(issue, terms);
        const age = Math.round((Date.parse(anchor) - Date.parse(issue)) / 86400_000);
        let status: "draft" | "sent" | "paid";
        let paidAt: string | null = null;
        const r = rand();
        if (age <= 6) status = r < 0.55 ? "draft" : r < 0.9 ? "sent" : "paid";
        else if (age <= terms) status = r < 0.08 ? "draft" : r < 0.78 ? "sent" : "paid";
        else if (age <= terms + 60) status = r < 0.3 ? "sent" : "paid";
        else status = r < 0.035 ? "sent" : "paid";
        if (status === "paid") {
          const latest = Math.min(age, terms + 12);
          paidAt = addDays(issue, Math.max(0, Math.min(latest, int(Math.max(1, terms - 8), terms + 12))));
          if (paidAt > anchor) paidAt = anchor;
        }
        const invId = insInv.get(
          wsId,
          pick(weighted),
          `${W.prefix}-${seq}`,
          seq,
          status,
          issue,
          due,
          paidAt,
          pick(REFERENCES),
          `${issue} 09:${String(int(0, 59)).padStart(2, "0")}:00`,
        )!.id;
        summary.invoices++;
        const nLines = Math.min(7, Math.max(1, Math.round(2 + rand() * 4)));
        const used = new Set<number>();
        for (let p = 1; p <= nLines; p++) {
          let s = Math.floor(rand() * SERVICES.length);
          while (used.has(s)) s = (s + 1) % SERVICES.length;
          used.add(s);
          const svc = SERVICES[s]!;
          const qty = svc.hourly ? int(svc.qty[0] * 2, svc.qty[1] * 2) / 2 : int(svc.qty[0], svc.qty[1]);
          const unit = svc.hourly ? int(svc.unit[0], svc.unit[1]) * 100 : int(svc.unit[0] / 5, svc.unit[1] / 5) * 500;
          insLine.run(invId, p, svc.d, qty, unit);
          summary.lineItems++;
        }
      });
    }
  })();

  db.exec("ANALYZE");
  return summary;
}

if (import.meta.main) {
  const size: SeedSize = process.env.SEED === "large" ? "large" : "small";
  const anchor = isDate(process.env.SEED_DATE) ? process.env.SEED_DATE : today();
  openDb();
  const t0 = performance.now();
  const s = await seed(size, anchor);
  console.log(
    `Seeded ${size} (${anchor}): ${s.workspaces} workspaces, ${s.users} users, ${s.clients} clients, ${s.invoices} invoices, ${s.lineItems} line items in ${Math.round(performance.now() - t0)} ms`,
  );
}
