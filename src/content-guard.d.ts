declare module 'content-guard' {
  export interface InjectionDetection {
    detected: boolean;
    score: number;
    severity: string;
  }

  export function detectInjection(text: string): InjectionDetection;
}
