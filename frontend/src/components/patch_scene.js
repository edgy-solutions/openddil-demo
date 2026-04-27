const fs = require('fs');
let code = fs.readFileSync('LtamdsView.tsx', 'utf8');

const sceneControllerStr = `function SceneController({ currentDepth, onDrillDown, onInterrogate, isTransitioning, setIsTransitioning, degraded }: any) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const groupsRef = useRef<THREE.Group[]>([]);
    
    const [selectedMesh, setSelectedMesh] = useState<THREE.Mesh | null>(null);

    const elements0 = useMemo(() => generateElements(0, degraded), [degraded]);
    const elements1 = useMemo(() => generateElements(1, degraded), [degraded]);
    const elements2 = useMemo(() => generateElements(2, degraded), [degraded]);
    const elements3 = useMemo(() => generateElements(3, degraded), [degraded]);
    
    const allElements = [elements0, elements1, elements2, elements3];

    useEffect(() => {
        // Instantly reset camera on depth change
        const targetCamPos = currentDepth === 0 ? new THREE.Vector3(15, 12, 20) : new THREE.Vector3(0, 0, 15);
        const targetLookAt = new THREE.Vector3(0, 0, 0);

        camera.position.copy(targetCamPos);
        camera.lookAt(targetLookAt);
        
        if (controlsRef.current) {
            controlsRef.current.target.copy(targetLookAt);
            controlsRef.current.update();
        }
        
        // Scale in new group
        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            activeGroup.scale.set(0.1, 0.1, 0.1);
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 1, y: 1, z: 1 }, 600)
                .easing(TWEEN.Easing.Back.Out)
                .onComplete(() => {
                    if (controlsRef.current) controlsRef.current.enabled = true;
                    setIsTransitioning(false);
                })
                .start();
        } else {
            if (controlsRef.current) controlsRef.current.enabled = true;
            setIsTransitioning(false);
        }
    }, [currentDepth, camera, setIsTransitioning]);

    const handleSelect = (data: ElementData, mesh: THREE.Mesh) => {
        if (isTransitioning) return;
        
        // Cancel any ongoing tweens
        tweenGroup.removeAll();
        
        setIsTransitioning(true);
        if (controlsRef.current) controlsRef.current.enabled = false;
        
        if (selectedMesh && selectedMesh !== mesh) {
            selectedMesh.scale.set(1, 1, 1);
        }
        
        setSelectedMesh(mesh);
        onInterrogate(data);
        
        new TWEEN.Tween(mesh.scale, tweenGroup)
            .to({ x: 1.2, y: 1.2, z: 2 }, 300)
            .easing(TWEEN.Easing.Back.Out)
            .start();
            
        const targetPos = new THREE.Vector3();
        mesh.getWorldPosition(targetPos);
        
        const offset = new THREE.Vector3(0, 0, currentDepth === 0 ? 5 : 8);
        offset.applyQuaternion(mesh.quaternion);
        if (currentDepth > 0) offset.z = 10;
        
        const newCamPos = targetPos.clone().add(offset);
        
        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: newCamPos.x, y: newCamPos.y, z: newCamPos.z }, 1000)
            .easing(TWEEN.Easing.Quadratic.Out)
            .start();

        const startTarget = controlsRef.current ? controlsRef.current.target.clone() : new THREE.Vector3(0, 0, 0);
        new TWEEN.Tween(startTarget, tweenGroup)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 1000)
            .easing(TWEEN.Easing.Quadratic.Out)
            .onUpdate(() => camera.lookAt(startTarget))
            .onComplete(() => {
                if (controlsRef.current) {
                    controlsRef.current.target.copy(targetPos);
                    controlsRef.current.enabled = true;
                    controlsRef.current.update();
                }
                setIsTransitioning(false);
            })
            .start();
    };

    const handleDrillDown = (_data: ElementData, mesh: THREE.Mesh) => {
        // Cancel any ongoing tweens (like the single-click zoom)
        tweenGroup.removeAll();
        
        setIsTransitioning(true);
        if (controlsRef.current) controlsRef.current.enabled = false;
        onInterrogate(null); // hide HUD
        
        if (selectedMesh) {
            // Instantly reset scale instead of tweening since we removed all tweens
            selectedMesh.scale.set(1, 1, 1);
            setSelectedMesh(null);
        }

        const targetPos = new THREE.Vector3();
        mesh.getWorldPosition(targetPos);

        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 800)
            .easing(TWEEN.Easing.Exponential.In)
            .onComplete(() => {
                onDrillDown();
            })
            .start();

        const startTarget = controlsRef.current ? controlsRef.current.target.clone() : new THREE.Vector3(0, 0, 0);
        new TWEEN.Tween(startTarget, tweenGroup)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 800)
            .easing(TWEEN.Easing.Exponential.In)
            .onUpdate(() => camera.lookAt(startTarget))
            .start();

        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 5, y: 5, z: 5 }, 800)
                .easing(TWEEN.Easing.Exponential.In)
                .start();
        }
    };
    const handlePointerMissed = () => {
        if (selectedMesh) {
            new TWEEN.Tween(selectedMesh.scale, tweenGroup).to({ x: 1, y: 1, z: 1 }, 300).start();
            setSelectedMesh(null);
            onInterrogate(null);
        }
    };

    return (
        <>
            <OrbitControls 
                ref={controlsRef} 
                enableDamping 
                dampingFactor={0.05} 
            />
            <group onPointerMissed={handlePointerMissed}>
                {allElements.map((elements, depth) => (
                    <group 
                        key={depth} 
                        ref={el => { if (el) groupsRef.current[depth] = el; }}
                        visible={currentDepth === depth}
                    >
                        {depth === 0 && (
                            <mesh>
                                <boxGeometry args={[7, 12, 5]} />
                                <meshPhongMaterial color={COLORS.housing} transparent opacity={0.9} />
                                <lineSegments>
                                    <edgesGeometry args={[new THREE.BoxGeometry(7, 12, 5)]} />
                                    <lineBasicMaterial color={0x334155} transparent opacity={0.5} />
                                </lineSegments>
                            </mesh>
                        )}
                        {elements.map((data) => (
                            <ElementMesh 
                                key={data.id} 
                                data={data} 
                                onSelect={handleSelect} 
                                onDrillDown={handleDrillDown} 
                            />
                        ))}
                    </group>
                ))}
            </group>
        </>
    );
}`;

const startIdx = code.indexOf('function SceneController');
const endIdx = code.indexOf('function ElementMesh');
if (startIdx !== -1 && endIdx !== -1) {
    code = code.substring(0, startIdx) + sceneControllerStr + '\n\n' + code.substring(endIdx);
    fs.writeFileSync('LtamdsView.tsx', code);
    console.log("Patched successfully");
} else {
    console.log("Could not find boundaries");
}
