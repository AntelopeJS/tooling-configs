---- MODULE Paths ----
EXTENDS Naturals

CONSTANT Detour

VARIABLE x

Init == x = 0

Jump == x = 0 /\ x' = 3

Step == /\ Detour
        /\ \/ x = 0 /\ x' = 1
           \/ x = 1 /\ x' = 2
           \/ x = 2 /\ x' = 4

Next == Jump \/ Step

Spec == Init /\ [][Next]_x

NotBad == x \notin {3, 4}
====
