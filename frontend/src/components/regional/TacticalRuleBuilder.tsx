// =============================================================================
// TacticalRuleBuilder — dynamic threat-heuristics editor (modal)
// =============================================================================
// DEMO_MOCK: the rule list is local component state and "Deploy" is a
// simulated 1s round-trip — there is no rule-deployment pipeline behind
// it. Kept as a recognizable regional affordance; wiring it to a real
// rule store / fusion-rule hot-reload path is future work. See ADR-0017.
import { useState } from 'react';
import { NumberInput, Button, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';
import { X, ChevronDown } from 'lucide-react';
import { DemoMockBanner } from '../DemoMockBanner';

const DEMO_MOCK = true;

interface Rule {
  id: string;
  target: string;
  vector: string;
  algorithm: string;
  threshold: number;
  action: string;
}

const INITIAL_RULES: Rule[] = [
  {
    id: 'RUL-101',
    target: 'Global Fleet',
    vector: 'coolant_pressure',
    algorithm: 'Absolute Threshold',
    threshold: 90.0,
    action: 'LOG_ONLY'
  }
];

interface TacticalRuleBuilderProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function TacticalRuleBuilder({ isOpen, onClose }: TacticalRuleBuilderProps) {
  const [target, setTarget] = useState('LTAMDS-04');
  const [vector, setVector] = useState('core_temp');
  const [algorithm, setAlgorithm] = useState('Absolute Threshold');
  const [threshold, setThreshold] = useState<number>(45.0);
  const [action, setAction] = useState('LOG_ONLY');

  const [rules, setRules] = useState<Rule[]>(INITIAL_RULES);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'deploying' | 'synced'>('idle');

  if (!isOpen) return null;

  const handleDeploy = () => {
    setDeployStatus('deploying');
    
    setTimeout(() => {
      const newRule: Rule = {
        id: `RUL-${Math.floor(Math.random() * 900) + 100}`,
        target,
        vector,
        algorithm,
        threshold,
        action
      };
      
      setRules((prev) => [newRule, ...prev]);
      setDeployStatus('synced');
      
      setTimeout(() => {
        setDeployStatus('idle');
        onClose();
      }, 1500);
    }, 1000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 border-t-4 border-t-cyan-500 rounded-xl p-6 w-full max-w-2xl flex flex-col max-h-[90vh] shadow-2xl shadow-cyan-900/20 overflow-visible relative">
        {DEMO_MOCK && <DemoMockBanner note="no rule-deployment pipeline" />}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
            <h3 className="text-cyan-400 font-bold uppercase tracking-widest text-sm">Dynamic Threat Heuristics</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase">Target Asset</label>
            <div className="relative">
              <select 
                value={target} 
                onChange={(e) => setTarget(e.target.value)} 
                className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-md py-2 pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                <option value="Global Fleet">Global Fleet</option>
                <option value="LTAMDS-04">LTAMDS-04</option>
                <option value="UAV-Swarm">UAV-Swarm</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                <ChevronDown className="w-4 h-4" />
              </div>
            </div>
          </div>
          
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase">Telemetry Vector</label>
            <div className="relative">
              <select 
                value={vector} 
                onChange={(e) => setVector(e.target.value)} 
                className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-md py-2 pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                <option value="core_temp">core_temp</option>
                <option value="coolant_pressure">coolant_pressure</option>
                <option value="vibration_z_axis">vibration_z_axis</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                <ChevronDown className="w-4 h-4" />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase">Detection Algorithm</label>
            <div className="relative">
              <select 
                value={algorithm} 
                onChange={(e) => setAlgorithm(e.target.value)} 
                className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-md py-2 pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                <option value="Rate of Change (Derivative)">Rate of Change (Derivative)</option>
                <option value="Statistical Anomaly (Z-Score)">Statistical Anomaly (Z-Score)</option>
                <option value="Absolute Threshold">Absolute Threshold</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                <ChevronDown className="w-4 h-4" />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase">Threshold Value</label>
            <NumberInput 
              value={threshold} 
              onValueChange={setThreshold} 
              step={0.1}
              className="bg-slate-800 text-slate-200 border-slate-700"
            />
          </div>

          <div className="space-y-1 col-span-2">
            <label className="text-xs text-slate-400 uppercase">Action Payload</label>
            <div className="relative">
              <select 
                value={action} 
                onChange={(e) => setAction(e.target.value)} 
                className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-md py-2 pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                <option value="LOG_ONLY">LOG_ONLY</option>
                <option value="THROTTLE_POWER">THROTTLE_POWER</option>
                <option value="INITIATE_RESUPPLY_SAGA">INITIATE_RESUPPLY_SAGA</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                <ChevronDown className="w-4 h-4" />
              </div>
            </div>
          </div>
        </div>

        <Button 
          className="w-full mb-6 font-bold tracking-widest transition-all duration-300"
          color={deployStatus === 'synced' ? 'emerald' : 'cyan'}
          variant="primary"
          loading={deployStatus === 'deploying'}
          loadingText="DEPLOYING..."
          onClick={handleDeploy}
          disabled={deployStatus !== 'idle'}
        >
          {deployStatus === 'synced' ? 'RULES SYNCED' : 'DEPLOY TO EDGE NETWORKS'}
        </Button>

        <div className="flex-1 overflow-auto border border-slate-800 rounded-md min-h-[200px]">
          <Table className="text-xs">
            <TableHead className="bg-slate-800/50 sticky top-0 z-10">
              <TableRow>
                <TableHeaderCell className="text-slate-400 font-semibold py-2">ID</TableHeaderCell>
                <TableHeaderCell className="text-slate-400 font-semibold py-2">Target</TableHeaderCell>
                <TableHeaderCell className="text-slate-400 font-semibold py-2">Vector</TableHeaderCell>
                <TableHeaderCell className="text-slate-400 font-semibold py-2">Thresh</TableHeaderCell>
                <TableHeaderCell className="text-slate-400 font-semibold py-2">Status</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                  <TableCell className="font-mono text-cyan-400 py-2">{rule.id}</TableCell>
                  <TableCell className="text-slate-300 py-2">{rule.target}</TableCell>
                  <TableCell className="text-slate-300 py-2">{rule.vector}</TableCell>
                  <TableCell className="text-amber-400 font-mono py-2">{rule.threshold}</TableCell>
                  <TableCell className="py-2">
                    <Badge color="emerald" size="xs">ACTIVE</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
