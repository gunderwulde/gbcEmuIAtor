// Runtime de C para SM83 (K1): helpers de multiplicación, división, módulo y
// desplazamientos, trampolín de bancos y crt0. ABI: docs/c-abi.md §6, §8 y §10.
//
// Convención de los helpers aritméticos: HL = operando izquierdo, DE = derecho (en los
// desplazamientos, A = número de bits), resultado en HL. Pisan AF y lo que diga su
// `clobbers` (tabla única: la usa clob() de codegen.ts y la comprueba tests/cc/runtime.test.ts
// contra el código, incluidas las dependencias).

export interface Helper {
  deps: string[];
  /** Pares que pisa además de AF y HL (con los de sus dependencias). */
  clobbers: ("bc" | "de")[];
  code: string;
}

export const HELPERS: Record<string, Helper> = {
  __mul16: {
    deps: [],
    clobbers: ["bc", "de"],
    // Suma y desplaza: por cada bit del multiplicador (DE, del más alto al más bajo) se
    // dobla el acumulado y se suma el multiplicando (BC) si el bit es 1. Si uno de los
    // dos factores cabe en 8 bits se usa como multiplicador y bastan 8 vueltas.
    code: `
__mul16:
        ld a,d
        or a
        jr z,.d8
        ld a,h
        or a
        jr nz,.full
        ld a,l
        ld l,e
        ld e,a
        ld h,d
        ld d,0
.d8:
        ld d,e
        ld e,0
        ld a,8
        jr .go
.full:
        ld a,16
.go:
        ld b,h
        ld c,l
        ld hl,0
.m1:
        add hl,hl
        sla e
        rl d
        jr nc,.m2
        add hl,bc
.m2:
        dec a
        jr nz,.m1
        ret`,
  },
  __divu16: {
    deps: [],
    clobbers: ["bc", "de"],
    // División con restauración, 16 vueltas. El SM83 no tiene SBC HL: se suma el divisor
    // negado (acarreo = cabía) y se deshace con la copia guardada en la pila. Si el resto
    // parcial pasa de 16 bits al doblarlo, seguro que es mayor que el divisor.
    // Sale con HL = cociente y DE = resto. Divisor 0: HL = $FFFF, DE = dividendo.
    code: `
__divu16:
        ld a,d
        or e
        jr z,.dz
        ld b,h
        ld c,l
        xor a
        sub e
        ld e,a
        ld a,0
        sbc a,d
        ld d,a
        ld hl,0
        ld a,16
.d1:
        sla c
        rl b
        rl l
        rl h
        jr c,.big
        push hl
        add hl,de
        jr nc,.no
        inc c
        add sp,2
        dec a
        jr nz,.d1
        jr .end
.no:
        pop hl
        dec a
        jr nz,.d1
        jr .end
.big:
        add hl,de
        inc c
        dec a
        jr nz,.d1
.end:
        ld d,h
        ld e,l
        ld h,b
        ld l,c
        ret
.dz:
        ld d,h
        ld e,l
        ld hl,$FFFF
        ret`,
  },
  __neghl: {
    deps: [],
    clobbers: [],
    code: `
__neghl:
        xor a
        sub l
        ld l,a
        sbc a,a
        sub h
        ld h,a
        ret`,
  },
  __abs2: {
    deps: ["__neghl"],
    clobbers: ["de"],
    // HL = |HL|, DE = |DE|.
    code: `
__abs2:
        bit 7,h
        call nz,__neghl
        bit 7,d
        ret z
        xor a
        sub e
        ld e,a
        sbc a,a
        sub d
        ld d,a
        ret`,
  },
  __divs16: {
    deps: ["__abs2", "__divu16", "__neghl"],
    clobbers: ["bc", "de"],
    // C99 6.5.5: el cociente trunca hacia cero; signo = signo(a) xor signo(b).
    code: `
__divs16:
        ld a,h
        xor d
        push af
        call __abs2
        call __divu16
        pop af
        bit 7,a
        ret z
        jp __neghl`,
  },
  __mods16: {
    deps: ["__abs2", "__divu16", "__neghl"],
    clobbers: ["bc", "de"],
    // C99 6.5.5: (a/b)*b + a%b == a, así que el resto lleva el signo del dividendo.
    code: `
__mods16:
        ld a,h
        push af
        call __abs2
        call __divu16
        ld h,d
        ld l,e
        pop af
        bit 7,a
        ret z
        jp __neghl`,
  },
  __shl16: {
    deps: [],
    clobbers: [],
    code: `
__shl16:
        cp 16
        jr nc,.z
        cp 8
        jr c,.l0
        ld h,l
        ld l,0
        sub 8
.l0:
        or a
        ret z
.l:
        add hl,hl
        dec a
        jr nz,.l
        ret
.z:
        ld hl,0
        ret`,
  },
  __shru16: {
    deps: [],
    clobbers: [],
    code: `
__shru16:
        cp 16
        jr nc,.z
        cp 8
        jr c,.l0
        ld l,h
        ld h,0
        sub 8
.l0:
        or a
        ret z
.l:
        srl h
        rr l
        dec a
        jr nz,.l
        ret
.z:
        ld hl,0
        ret`,
  },
  __shrs16: {
    deps: [],
    clobbers: [],
    // Con 8 o más bits: L = H y H = signo; la cuenta se guarda en la pila (no en B: el
    // generador puede tener un valor vivo en BC, ver clob()).
    code: `
__shrs16:
        cp 16
        jr nc,.z
        cp 8
        jr c,.l0
        sub 8
        push af
        ld l,h
        ld a,h
        rla
        sbc a,a
        ld h,a
        pop af
.l0:
        or a
        ret z
.l:
        sra h
        rr l
        dec a
        jr nz,.l
        ret
.z:
        ld a,h
        rla
        sbc a,a
        ld h,a
        ld l,a
        ret`,
  },
  __bcall: {
    deps: [],
    // Llama a una función C, que puede pisarlo todo.
    clobbers: ["bc", "de"],
    // Trampolín de bancos (docs/c-abi.md §8). DE = función, B = banco. Conserva A y HL
    // (primer argumento a la ida, valor de retorno a la vuelta). __cur_bank se actualiza
    // antes de escribir en el MBC para que una interrupción vea siempre el banco bueno.
    code: `
__bcall:
        ld c,a
        ldh a,[__cur_bank]
        push af
        ld a,b
        ldh [__cur_bank],a
        ld [$2000],a
        ld a,c
        call .jp_de
        ld c,a
        pop af
        ldh [__cur_bank],a
        ld [$2000],a
        ld a,c
        ret
.jp_de:
        push de
        ret`,
  },
};

/** Máscara de clob() (DE = 1, BC = 2) de lo que pisa un helper. */
export function helperClob(name: string): number {
  const c = HELPERS[name]!.clobbers;
  return (c.includes("de") ? 1 : 0) | (c.includes("bc") ? 2 : 0);
}

/** Cierra `used` con las dependencias y devuelve el código en orden estable. */
export function helperCode(used: Set<string>): string {
  const all = new Set<string>();
  const add = (n: string) => {
    if (all.has(n)) return;
    all.add(n);
    for (const d of HELPERS[n]!.deps) add(d);
  };
  for (const n of used) add(n);
  return Object.keys(HELPERS).filter((n) => all.has(n)).map((n) => HELPERS[n]!.code).join("\n");
}

/** Rutina de OAM DMA (se copia a HRAM): A = byte alto del origen. 160 ciclos M de espera. */
export const OAM_DMA_CODE = `
__oam_dma_rom:
        ldh [$FF46],a
        ld a,40
.w:
        dec a
        jr nz,.w
        ret`;
export const OAM_DMA_SIZE = 8;

/** Vectores de interrupción y entrada en $100 (docs/c-abi.md §6). */
export function vectors(isr: (string | undefined)[]): string {
  const out: string[] = [`SECTION "C vectors", ROM0[$40]`];
  isr.forEach((l, i) => {
    out.push(l ? `        jp ${l}` : "        reti");
    if (i < isr.length - 1) out.push(`        ds ${0x48 + 8 * i}-@, $FF`);
  });
  out.push(`SECTION "C entry", ROM0[$100]`, "        nop", "        jp __start", "        ds $150-@, 0");
  return out.join("\n");
}

/**
 * crt0 (docs/c-abi.md §6): pila, WRAM0 a cero (OAM sombra, marcos, BSS, pila), copia de
 * .data, rutina de DMA a HRAM, banco actual y main. `dataSize` en bytes.
 */
export function crt0(dataSize: number): string {
  const data = dataSize === 0 ? "" : `
        ld hl,__data_img
        ld de,__data_start
        ld bc,${dataSize}
.cp:
        ld a,[hl+]
        ld [de],a
        inc de
        dec bc
        ld a,b
        or c
        jr nz,.cp`;
  return `
__start:
        di
        ld sp,$D000
        xor a
        ld hl,$C000
.z:
        ld [hl+],a
        ld [hl+],a
        ld [hl+],a
        ld [hl+],a
        bit 4,h
        jr z,.z${data}
        ld c,LOW(__oam_dma_hram)
        ld hl,__oam_dma_rom
        ld b,${OAM_DMA_SIZE}
.dma:
        ld a,[hl+]
        ldh [c],a
        inc c
        dec b
        jr nz,.dma
        ld a,1
        ldh [__cur_bank],a
        call _main
__exit:
        di
        ld b,b
.h:
        halt
        nop
        jr .h`;
}
