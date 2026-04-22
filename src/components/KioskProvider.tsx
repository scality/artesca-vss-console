"use client";

import { createContext, useContext } from "react";

interface KioskContextValue {
  kiosk: boolean;
}

const KioskContext = createContext<KioskContextValue>({ kiosk: false });

export function KioskProvider({
  children,
  initialKiosk,
}: {
  children: React.ReactNode;
  initialKiosk: boolean;
}) {
  return (
    <KioskContext.Provider value={{ kiosk: initialKiosk }}>
      {children}
    </KioskContext.Provider>
  );
}

export function useKiosk(): KioskContextValue {
  return useContext(KioskContext);
}
