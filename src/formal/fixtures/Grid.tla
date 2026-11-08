---- MODULE Grid ----
EXTENDS Naturals
CONSTANT N
VARIABLES a, b, c
vars == <<a, b, c>>
Init == a = 0 /\ b = 0 /\ c = 0
IncA == a < N /\ a' = a + 1 /\ UNCHANGED <<b, c>>
IncB == b < N /\ b' = b + 1 /\ UNCHANGED <<a, c>>
IncC == c < N /\ c' = c + 1 /\ UNCHANGED <<a, b>>
Next == IncA \/ IncB \/ IncC
Spec == Init /\ [][Next]_vars
Near == a + b + c < 2 * N
NoCorner == ~(a = N /\ b = N - 1)

Low == a + b + c < 3
====
