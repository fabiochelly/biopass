#!/usr/bin/env python3
"""Affiche « versionCode versionName » d'une APK en lisant son AndroidManifest.xml binaire (AXML).
   python3 -I tools/apk-version.py android/dist/biopass.apk   →   8 1.3.4
Aucune dépendance (pas besoin du SDK Android)."""
import struct
import sys
import zipfile

VERSION_CODE, VERSION_NAME = 0x0101021B, 0x0101021C  # identifiants des attributs android:


def strings(data, off):
    count, _, flags, start = struct.unpack_from('<IIII', data, off + 8)
    utf8 = flags & 0x100
    out = []
    for i in range(count):
        p = off + start + struct.unpack_from('<I', data, off + 28 + 4 * i)[0]
        if utf8:
            p += 2 if data[p] & 0x80 else 1  # longueur UTF-16 (ignorée)
            n = data[p]
            if n & 0x80:
                n, p = ((n & 0x7F) << 8) | data[p + 1], p + 2
            else:
                p += 1
            out.append(data[p:p + n].decode('utf-8', 'replace'))
        else:
            n = struct.unpack_from('<H', data, p)[0]
            out.append(data[p + 2:p + 2 + 2 * n].decode('utf-16-le', 'replace'))
    return out


def version(apk):
    data = zipfile.ZipFile(apk).read('AndroidManifest.xml')
    off, pool, resmap = 8, [], []
    while off < len(data):
        ctype, hsize, size = struct.unpack_from('<HHI', data, off)
        if ctype == 0x0001:
            pool = strings(data, off)
        elif ctype == 0x0180:
            resmap = list(struct.unpack_from(f'<{(size - 8) // 4}I', data, off + 8))
        elif ctype == 0x0102:  # début d'élément
            name = struct.unpack_from('<I', data, off + 20)[0]
            if pool[name] == 'manifest':
                astart, _, acount = struct.unpack_from('<HHH', data, off + 24)
                code = vname = None
                for i in range(acount):
                    a = off + 16 + astart + 20 * i
                    # attribut : espace de noms, nom, valeur brute, taille, 0, type, donnée
                    _, aname, raw, _, _, dtype, value = struct.unpack_from('<IIIHBBI', data, a)
                    rid = resmap[aname] if aname < len(resmap) else None
                    if rid == VERSION_CODE:
                        code = value
                    elif rid == VERSION_NAME:
                        vname = pool[raw] if raw != 0xFFFFFFFF else (pool[value] if dtype == 3 else str(value))
                return code, vname
        off += size
    return None, None


if __name__ == '__main__':
    code, name = version(sys.argv[1])
    print(code, name)
