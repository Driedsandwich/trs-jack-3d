export interface InjectedRoute {
  label: string
  code: string
  args: string[]
  preload?: string
  env?: Record<string, string>
}
export declare function injectedRoutes(keep?: string[]): InjectedRoute[]
