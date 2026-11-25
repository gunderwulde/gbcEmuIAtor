/* Oráculo de aritmética de 16 bits (K1, tests/cc/oracle.test.ts).
 *
 * El mismo fuente se compila con el compilador de K1 (int de 16 bits) y con clang a
 * wasm32 (int de 32 bits, con int16_t = short). Para que las dos semánticas coincidan,
 * cada resultado intermedio se trunca a 16 bits con S()/U() y se evitan los casos
 * indefinidos de C (división por cero, -32768 / -1, desplazamientos de 16 o más).
 */
#ifdef __K1CC__
typedef int i16;
typedef unsigned u16;
#define EXPORT(n)
#else
typedef short i16;
typedef unsigned short u16;
#define EXPORT(n) __attribute__((export_name(n)))
#endif
typedef signed char i8;
typedef unsigned char u8;

#define S(x) ((i16)(x))
#define U(x) ((u16)(x))
#define N 26
#define K 46

const i16 in_a[N] = { 0, 1, -1, 32767, -32768, 255, 256, -255, 1000, -7, 12345, -12345, 3,
                      100, -100, 7, 0x7F80, -2, 9999, 640, -32767, 81, 17, 4096, -4096, 513 };
const i16 in_b[N] = { 0, 1, 1, -1, -1, 255, 3, 7, -33, 2, 99, -100, -32768,
                      7, 7, -7, 15, -32767, 30000, 64, 2, -9, 4, 12, 13, 257 };

i16 out[N * K];

u16 gcd(u16 x, u16 y)
{
    while (y) {
        u16 t = U(x % y);
        x = y;
        y = t;
    }
    return x;
}

i16 bits(u16 v)
{
    i16 n = 0;
    for (; v; v >>= 1)
        n += v & 1;
    return n;
}

void calc(i16 a, i16 b, i16 *o)
{
    u16 ua = U(a), ub = U(b);
    u8 ca = (u8)a, cb = (u8)b;
    i8 sa = (i8)a, sb = (i8)b;
    int sh = b & 15;
    int okdiv = b != 0 && !(a == -32767 - 1 && b == -1);

    o[0] = S(a + b);
    o[1] = S(a - b);
    o[2] = S((unsigned)ua * ub);
    o[3] = okdiv ? S(a / b) : 0;
    o[4] = okdiv ? S(a % b) : 0;
    o[5] = ub ? S(ua / ub) : 0;
    o[6] = ub ? S(ua % ub) : 0;
    o[7] = S(ua << sh);
    o[8] = S(a >> sh);
    o[9] = S(ua >> sh);
    o[10] = a < b;
    o[11] = ua < ub;
    o[12] = a >= b;
    o[13] = ua >= ub;
    o[14] = a == b;
    o[15] = S(a & b);
    o[16] = S(a | b);
    o[17] = S(a ^ b);
    o[18] = S(~a);
    o[19] = S(-a);
    o[20] = (u8)(ca + cb);
    o[21] = (u8)(ca * cb);
    o[22] = cb ? ca / cb : 0;
    o[23] = cb ? ca % cb : 0;
    o[24] = sa < sb;
    o[25] = S(sa * 3);
    o[26] = ca > cb;
    o[27] = S(sa >> 2);
    o[28] = S(a * 7);
    o[29] = S(a / 10);
    o[30] = S(a % 10);
    o[31] = S(ua / 10);
    o[32] = S(a * -3);
    o[33] = S(a >> 4);
    o[34] = S(ua >> 9);
    o[35] = S(ua << 3);
    o[36] = S(ca << 4);
    o[37] = (a > 0 && b < 0) || a == b;
    o[38] = S(a / 4);
    o[39] = S(a % 8);
    o[40] = S(ua * 256u);
    o[41] = S(ua / 256);
    o[42] = S(a / -2);
    o[43] = S(gcd(ua, ub));
    o[44] = bits(ua) + bits(ub);
    o[45] = a <= b ? S(b - a) : S(sa * sb);
}

EXPORT("out_ptr") i16 *out_ptr(void) { return out; }

#ifdef __K1CC__
void main(void)
#else
EXPORT("run") void run(void)
#endif
{
    int i;
    for (i = 0; i < N; i++)
        calc(in_a[i], in_b[i], &out[i * K]);
}
