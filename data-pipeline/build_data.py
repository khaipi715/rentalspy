#!/usr/bin/env python3
"""Download public data and build the JSON files the RentalSpy website uses.

Sources (all free, public):
  - SA Government Private Rental Report (bond lodgements), data.sa.gov.au
  - SA Police crime statistics, data.sa.gov.au
  - G-NAF (every address in Australia), data.gov.au. Only the SA files are
    downloaded, using HTTP range requests, about 75 MB instead of 1.7 GB.
  - Suburb outlines and landmarks from OpenStreetMap (Nominatim)

Run:  pip install openpyxl && python3 data-pipeline/build_data.py
Output goes to src/data/ (used at build time) and public/data/ (loaded by the browser).
To add suburbs, add them to SUBURBS below.
"""
import collections
import csv
import io
import json
import math
import os
import re
import shutil
import ssl
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DATA = os.path.join(ROOT, "src", "data")
PUB_DATA = os.path.join(ROOT, "public", "data")
FOCUS = "Mawson Lakes"
SUBURBS = [
    "Mawson Lakes", "Pooraka", "Parafield Gardens", "Salisbury", "Salisbury South",
    "Salisbury Downs", "Para Hills", "Para Hills West", "Walkley Heights",
    "Ingle Farm", "Dry Creek", "Green Fields",
]
LANDMARKS = {
    "station": ("Mawson Interchange (train and bus)", "Mawson Interchange, Mawson Lakes"),
    "uni": ("UniSA Mawson Lakes campus", "University of South Australia Mawson Lakes"),
    "shops": ("Woolworths, Mawson Central", "Woolworths Mawson Lakes"),
    "lake": ("Sir Douglas Mawson Lake", "Sir Douglas Mawson Lake"),
    "airport": ("Parafield Airport", "Parafield Airport"),
}
CBD = ("Adelaide city centre", -34.9285, 138.6007)
UA = "RentalSpy-data-pipeline/1.0"
CKAN = "https://data.sa.gov.au/data/api/3/action/package_show?id="
GNAF_CKAN = "https://data.gov.au/data/api/3/action/package_show?id=geocoded-national-address-file-g-naf"

_cafile = os.environ.get("SSL_CERT_FILE") or ("/root/.ccr/ca-bundle.crt" if os.path.exists("/root/.ccr/ca-bundle.crt") else None)
CTX = ssl.create_default_context(cafile=_cafile)


def fetch(url, headers=None, tries=4):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            return urllib.request.urlopen(req, context=CTX, timeout=120).read()
        except Exception:
            if t == tries - 1:
                raise
            time.sleep(2 * (t + 1))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def title(s):
    out = []
    for w in s.split():
        out.append("Mc" + w[2:].capitalize() if w.startswith("MC") and len(w) > 2 else w.capitalize())
    return " ".join(out)


def resources(pkg):
    res = json.loads(fetch(CKAN + pkg))["result"]["resources"]
    return sorted(res, key=lambda r: r.get("created") or "")


# ---------------------------------------------------------------- rent
def parse_rent(path, wanted):
    rows = list(openpyxl.load_workbook(path, read_only=True, data_only=True)["Suburb"].iter_rows(values_only=True))
    h = next(i for i, r in enumerate(rows) if r and len(r) > 2 and r[1] == "Count" and r[2] == "Median")
    top, sub, lab = rows[h - 2], rows[h - 1], rows[h]
    cols, g, b = {}, None, None
    for j in range(1, len(top)):
        t = top[j]
        if isinstance(t, str):
            m = re.match(r"(.*) (Count|Median)$", t)
            if m:
                cols[j] = (m.group(1), "Total", m.group(2).lower())
                b = None
                continue
            g, b = t, None
        if isinstance(sub[j], str):
            b = sub[j].replace("Bedrooms", "bedrooms").replace("Bedroom", "bedroom")
        if isinstance(lab[j], str) and g and b:
            cols[j] = (g, b, lab[j].lower())
    res = {}
    for r in rows[h + 1:]:
        if r and isinstance(r[0], str) and r[0].strip() in wanted and r[0].strip() not in res:
            d = {}
            for j, (gg, bb, s) in cols.items():
                v = r[j]
                if v is not None:
                    d.setdefault(gg, {}).setdefault(bb, {})[s] = v
            res[r[0].strip()] = d
    return res


def build_rent():
    rs = [r for r in resources("private-rent-report") if re.search(r"\d{4}-\d{2}$", r.get("name", ""))]
    rs = sorted(rs, key=lambda r: r["name"][-7:])[-17:]  # about 4 years of quarters
    out = {}
    tmp = tempfile.mkdtemp()
    for r in rs:
        q = r["name"][-7:]
        p = os.path.join(tmp, q + ".xlsx")
        open(p, "wb").write(fetch(r["url"]))
        try:
            out[q] = parse_rent(p, set(SUBURBS) | {"Metro Total"})
            print("rent", q, len(out[q]), "suburbs", flush=True)
        except Exception as e:  # an odd file should not stop the build
            print("rent skip", q, e, flush=True)
    shutil.rmtree(tmp)
    return out


# ---------------------------------------------------------------- crime
def build_crime():
    rs = [r for r in resources("crime-statistics") if r.get("name", "").startswith("Crime Statistics") and re.search(r"\d{4}-\d{2}$", r["name"])]
    full = [r for r in rs if "Q" not in r["name"].split()[-1]]
    full = sorted(full, key=lambda r: r["name"][-7:])[-2:]
    wanted = {s.upper() for s in SUBURBS}
    out = {}
    for r in full:
        year = r["name"][-7:]
        c = collections.defaultdict(collections.Counter)
        text = fetch(r["url"]).decode("utf-8-sig", "replace")
        for row in csv.DictReader(io.StringIO(text)):
            s = (row.get("Suburb - Incident") or "").strip()
            if s in wanted:
                n = int(row.get("Offence count") or 0)
                c[s]["total"] += n
                c[s]["L3:" + row["Offence Level 3 Description"]] += n
        out[year] = {k: dict(v) for k, v in c.items()}
        print("crime", year, flush=True)
    return out


def assaults(c):
    return sum(c.get("L3:" + k, 0) for k in [
        "Serious Assault", "Common Assault",
        "Serious Assault not resulting in injury", "Serious Assault resulting in injury"])


# ---------------------------------------------------------------- OSM
def nominatim(params):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    time.sleep(1.2)  # Nominatim usage policy: max 1 request per second
    return json.loads(fetch(url))


def build_osm():
    polys = {}
    for s in SUBURBS:
        fs = nominatim({"q": f"{s}, South Australia", "format": "geojson", "limit": 1, "featureType": "settlement",
                        "polygon_geojson": 1, "polygon_threshold": 0.0004, "countrycodes": "au"})["features"]
        if fs:
            geo = fs[0]["geometry"]
            ring = geo["coordinates"][0] if geo["type"] == "Polygon" else max((p[0] for p in geo["coordinates"]), key=len)
            polys[s] = [[round(x, 5), round(y, 5)] for x, y in ring]
    pts = {}
    for k, (label, q) in LANDMARKS.items():
        r = nominatim({"q": q, "format": "jsonv2", "limit": 1, "countrycodes": "au"})
        if r:
            pts[k] = [label, round(float(r[0]["lat"]), 6), round(float(r[0]["lon"]), 6)]
    lake = nominatim({"q": "Sir Douglas Mawson Lake", "format": "geojson", "limit": 1, "polygon_geojson": 1, "polygon_threshold": 0.0001})["features"]
    lake = [[round(x, 5), round(y, 5)] for x, y in lake[0]["geometry"]["coordinates"][0]] if lake else []
    return polys, pts, lake


# ---------------------------------------------------------------- G-NAF
class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        self.size = int(urllib.request.urlopen(req, context=CTX).headers["Content-Length"])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def readinto(self, b):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(b)) - 1
        d = fetch(self.url, {"Range": f"bytes={self.pos}-{end}"})
        b[:len(d)] = d
        self.pos += len(d)
        return len(d)


def build_addresses():
    res = json.loads(fetch(GNAF_CKAN))["result"]["resources"]
    zips = sorted([r for r in res if (r.get("format") or "").upper() == "ZIP" and "GDA2020" in r.get("name", "")],
                  key=lambda r: r.get("created") or "")
    url = zips[-1]["url"]
    print("G-NAF", zips[-1]["name"], flush=True)
    z = zipfile.ZipFile(io.BufferedReader(RangeFile(url), buffer_size=16 * 1024 * 1024))
    want = ["SA_LOCALITY_psv.psv", "SA_STREET_LOCALITY_psv.psv", "SA_ADDRESS_DETAIL_psv.psv", "SA_ADDRESS_DEFAULT_GEOCODE_psv.psv"]
    tmp = tempfile.mkdtemp()
    for i in z.infolist():
        base = i.filename.split("/")[-1]
        if "/Standard/" in i.filename and base in want:
            with z.open(i) as src, open(os.path.join(tmp, base), "wb") as dst:
                shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
    rd = lambda f: csv.DictReader(open(os.path.join(tmp, f), newline="", encoding="utf-8"), delimiter="|")
    upper = {s.upper() for s in SUBURBS}
    loc = {r["LOCALITY_PID"]: r["LOCALITY_NAME"] for r in rd(want[0]) if not r["DATE_RETIRED"] and r["LOCALITY_NAME"] in upper}
    st = {r["STREET_LOCALITY_PID"]: (r["STREET_NAME"], r["STREET_TYPE_CODE"], r["STREET_SUFFIX_CODE"])
          for r in rd(want[1]) if r["LOCALITY_PID"] in loc and not r["DATE_RETIRED"]}
    addr = {r["ADDRESS_DETAIL_PID"]: r for r in rd(want[2])
            if r["LOCALITY_PID"] in loc and not r["DATE_RETIRED"] and r["ALIAS_PRINCIPAL"] == "P"
            and r["STREET_LOCALITY_PID"] in st and r["NUMBER_FIRST"]}
    geo = {r["ADDRESS_DETAIL_PID"]: (round(float(r["LATITUDE"]), 6), round(float(r["LONGITUDE"]), 6))
           for r in rd(want[3]) if r["ADDRESS_DETAIL_PID"] in addr and not r["DATE_RETIRED"]}
    shutil.rmtree(tmp)
    streets = collections.defaultdict(list)
    for pid, r in addr.items():
        if pid not in geo:
            continue
        n, t, sfx = st[r["STREET_LOCALITY_PID"]]
        sname = title(" ".join(x for x in [n, t, sfx] if x))
        num = f"{r['NUMBER_FIRST_PREFIX']}{r['NUMBER_FIRST']}{r['NUMBER_FIRST_SUFFIX']}"
        if r["NUMBER_LAST"]:
            num += f"-{r['NUMBER_LAST_PREFIX']}{r['NUMBER_LAST']}{r['NUMBER_LAST_SUFFIX']}"
        unit = f"{r['FLAT_NUMBER_PREFIX']}{r['FLAT_NUMBER']}{r['FLAT_NUMBER_SUFFIX']}" if r["FLAT_NUMBER"] else ""
        streets[(title(loc[r["LOCALITY_PID"]]), sname)].append({
            "id": pid, "n": num, "u": unit, "pc": r["POSTCODE"], "lat": geo[pid][0], "lon": geo[pid][1]})

    def key(a):
        m = re.match(r"\D*(\d+)", a["n"])
        u = re.match(r"\D*(\d+)", a["u"] or "0")
        return (int(m.group(1)) if m else 0, a["n"], int(u.group(1)) if u else 0, a["u"])

    index = []
    sdir = os.path.join(PUB_DATA, "streets")
    shutil.rmtree(sdir, ignore_errors=True)
    for (sub, sname), lst in sorted(streets.items()):
        lst.sort(key=key)
        s = {"suburb": sub, "name": sname, "slug": slug(sname), "sslug": slug(sub),
             "lat": round(sum(a["lat"] for a in lst) / len(lst), 5),
             "lon": round(sum(a["lon"] for a in lst) / len(lst), 5),
             "count": len(lst), "pc": lst[0]["pc"]}
        index.append(s)
        os.makedirs(os.path.join(sdir, s["sslug"]), exist_ok=True)
        json.dump({**s, "addresses": lst}, open(os.path.join(sdir, s["sslug"], s["slug"] + ".json"), "w"), separators=(",", ":"))
    print("addresses", sum(s["count"] for s in index), "streets", len(index), flush=True)
    return index, zips[-1]["name"]


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return round(2 * 6371 * math.asin(math.sqrt(h)), 1)


def main():
    os.makedirs(SRC_DATA, exist_ok=True)
    os.makedirs(PUB_DATA, exist_ok=True)
    rent = build_rent()
    crime = build_crime()
    polys, pts, lake = build_osm()
    streets, gnaf_release = build_addresses()

    qs = sorted(rent)
    years = sorted(crime)
    types = {"Flats/Units": "unit", "Houses": "house"}
    beds = ["1 bedroom", "2 bedrooms", "3 bedrooms", "4+ bedrooms", "Total"]

    def series(name, group, bed):
        out = []
        for q in qs:
            c = rent[q].get(name, {}).get(group, {}).get(bed)
            m = rent[q].get("Metro Total", {}).get(group, {}).get(bed)
            out.append([q, c.get("count") if c else None, c.get("median") if c else None, m.get("median") if m else None])
        return out

    suburbs = []
    street_counts = collections.Counter(s["sslug"] for s in streets)
    addr_counts = collections.Counter()
    for s in streets:
        addr_counts[s["sslug"]] += s["count"]
    for name in SUBURBS:
        rs = {f"{tl}|{b}": series(name, g, b) for g, tl in types.items() for b in beds}
        rs["all|Total"] = series(name, "Total", "Total")
        up = name.upper()
        cy = crime.get(years[-1], {}).get(up, {}) if years else {}
        cp = crime.get(years[-2], {}).get(up, {}) if len(years) > 1 else {}
        top = sorted([(k[3:], v) for k, v in cy.items() if k.startswith("L3:")], key=lambda x: -x[1])[:8]
        centre = None
        if name in polys:
            ring = polys[name]
            centre = [round(sum(p[1] for p in ring) / len(ring), 5), round(sum(p[0] for p in ring) / len(ring), 5)]
        suburbs.append({
            "name": name, "slug": slug(name), "rent": rs,
            "crime": {"year": years[-1] if years else None, "prevYear": years[-2] if len(years) > 1 else None,
                      "total": cy.get("total", 0), "totalPrev": cp.get("total", 0),
                      "breakins": cy.get("L3:SCT - Residence", 0), "breakinsPrev": cp.get("L3:SCT - Residence", 0),
                      "assaults": assaults(cy), "top": top},
            "poly": polys.get(name), "centre": centre,
            "streets": street_counts.get(slug(name), 0), "addresses": addr_counts.get(slug(name), 0),
        })
    dist = {}
    for base in ["uni", "station"]:
        if base in pts:
            b = (pts[base][1], pts[base][2])
            d = {k: km(b, (v[1], v[2])) for k, v in pts.items() if k != base}
            d["cbd"] = km(b, (CBD[1], CBD[2]))
            dist[base] = d
    meta = {"focus": FOCUS, "quarters": qs, "latestQuarter": qs[-1], "crimeYears": years,
            "gnafRelease": gnaf_release, "built": time.strftime("%Y-%m-%d"),
            "landmarks": {**pts, "cbd": list(CBD)}, "lake": lake, "distances": dist}
    json.dump(suburbs, open(os.path.join(SRC_DATA, "suburbs.json"), "w"), separators=(",", ":"))
    json.dump(meta, open(os.path.join(SRC_DATA, "meta.json"), "w"), separators=(",", ":"))
    json.dump(streets, open(os.path.join(SRC_DATA, "streets.json"), "w"), separators=(",", ":"))
    # small search index for the browser: [name, suburb, sslug, slug, count]
    json.dump([[s["name"], s["suburb"], s["sslug"], s["slug"], s["count"]] for s in streets],
              open(os.path.join(PUB_DATA, "search.json"), "w"), separators=(",", ":"))
    print("done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
